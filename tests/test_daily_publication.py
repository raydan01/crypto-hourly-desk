"""Exercise the real publisher against disposable local Git remotes (no network)."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/publish-daily-snapshot.sh'
DAILY = 'data/market-opportunities-daily-latest.json'
LONG = 'data/market-opportunities-long-term-latest.json'


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          text=True, capture_output=True).stdout.strip()


@pytest.fixture
def repos(tmp_path):
    remote, local, other = (tmp_path / name for name in ['remote.git', 'local', 'other'])
    subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
    subprocess.run(['git', 'clone', str(remote), str(local)], check=True, capture_output=True)
    git(local, 'checkout', '-b', 'main')
    git(local, 'config', 'user.name', 'Test')
    git(local, 'config', 'user.email', 'test@example.invalid')
    (local / 'data').mkdir()
    for path in [DAILY, LONG]:
        (local / path).write_text('old\n')
    git(local, 'add', '.')
    git(local, 'commit', '-m', 'initial')
    git(local, 'push', 'origin', 'main')
    subprocess.run(['git', 'clone', '-b', 'main', str(remote), str(other)], check=True, capture_output=True)
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.invalid')
    return remote, local, other


def update(repo, path, content):
    (repo / path).write_text(content)
    git(repo, 'add', path)
    git(repo, 'commit', '-m', 'concurrent change')
    git(repo, 'push', 'origin', 'main')


def publish(local, env=None):
    return subprocess.run(['bash', str(SCRIPT)], cwd=local, env=env,
                          text=True, capture_output=True)


def changed(local):
    (local / DAILY).write_text('new daily\n')
    (local / LONG).write_text('new long\n')


def assert_snapshots(remote):
    assert git(remote, 'show', f'main:{DAILY}') == 'new daily'
    assert git(remote, 'show', f'main:{LONG}') == 'new long'


def test_rebases_over_existing_concurrent_commit(repos):
    remote, local, other = repos
    changed(local)
    update(other, 'hourly.json', 'new hourly')
    assert publish(local).returncode == 0
    assert_snapshots(remote)
    assert git(remote, 'show', 'main:hourly.json') == 'new hourly'


def test_no_change_does_not_commit_or_push(repos):
    remote, local, _ = repos
    before = git(remote, 'rev-parse', 'main')
    assert publish(local).returncode == 0
    assert git(remote, 'rev-parse', 'main') == before


def test_conflict_preserves_remote_and_local_capture(repos):
    remote, local, other = repos
    changed(local)
    update(other, DAILY, 'newer remote capture\n')
    before = git(remote, 'rev-parse', 'main')
    result = publish(local)
    assert result.returncode != 0
    assert 'refusing to overwrite' in result.stderr
    assert git(remote, 'rev-parse', 'main') == before
    assert (local / DAILY).read_text() == 'new daily\n'
    assert not (local / '.git/rebase-merge').exists()


@pytest.mark.parametrize('staged', [False, True])
def test_unexpected_paths_are_not_published(repos, staged):
    remote, local, _ = repos
    before = git(remote, 'rev-parse', 'main')
    changed(local)
    (local / 'unrelated.txt').write_text('must not publish')
    if staged:
        git(local, 'add', 'unrelated.txt')
    assert publish(local).returncode != 0
    assert git(remote, 'rev-parse', 'main') == before


def wrapper(tmp_path, body):
    bindir = tmp_path / 'bin'
    bindir.mkdir()
    real_git = shutil.which('git')
    (bindir / 'git').write_text('#!/bin/bash\n' + body + '\nexec ' + real_git + ' "$@"\n')
    (bindir / 'git').chmod(0o755)
    (bindir / 'sleep').write_text('#!/bin/bash\nexit 0\n')
    (bindir / 'sleep').chmod(0o755)
    return {**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH']}


def test_retries_push_race_without_losing_concurrent_commit(repos, tmp_path):
    remote, local, other = repos
    changed(local)
    real = shutil.which('git')
    marker = tmp_path / 'raced'
    body = f'''if [[ "$1" == push && ! -e "{marker}" ]]; then
  touch "{marker}"
  echo concurrent > "{other}/hourly.json"
  {real} -C "{other}" add hourly.json
  {real} -C "{other}" commit -m concurrent
  {real} -C "{other}" push origin main
fi'''
    result = publish(local, wrapper(tmp_path, body))
    assert result.returncode == 0, result.stderr
    assert marker.exists()
    assert_snapshots(remote)
    assert git(remote, 'show', 'main:hourly.json') == 'concurrent'


def test_rejections_are_bounded_and_never_force_push(repos, tmp_path):
    remote, local, _ = repos
    changed(local)
    before = git(remote, 'rev-parse', 'main')
    calls = tmp_path / 'pushes'
    body = f'''if [[ "$1" == push ]]; then
  echo "$*" >> "{calls}"
  exit 1
fi'''
    result = publish(local, wrapper(tmp_path, body))
    assert result.returncode != 0
    assert calls.read_text().splitlines() == ['push origin HEAD:main'] * 3
    assert git(remote, 'rev-parse', 'main') == before
