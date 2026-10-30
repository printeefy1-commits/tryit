#!/usr/bin/env python3
"""One-time, scoped Nginx upload limits. Preserves TLS/proxy configuration."""
import argparse
import datetime
import difflib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

LIMITS = {
    'client_max_body_size': '120m',
    'client_body_timeout': '120s',
    'proxy_read_timeout': '600s',
    'proxy_send_timeout': '600s',
}

def updated_limits(text):
    pattern = r'''\#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[{};]|[^\s{};\#]+'''
    tokens = [m for m in re.finditer(pattern, text) if not m.group().startswith('#')]
    servers, stack, edits = [], [], []
    for i, token in enumerate(tokens):
        value = token.group()
        if value == '{':
            server = {'open': token.end(), 'seen': set()} if i and tokens[i-1].group() == 'server' else None
            stack.append(server)
            if server is not None:
                servers.append(server)
        elif value == '}':
            if not stack:
                raise ValueError('Unbalanced Nginx configuration.')
            stack.pop()
        elif value in LIMITS and stack and any(s is not None for s in stack):
            if i + 2 >= len(tokens) or tokens[i+2].group() != ';':
                raise ValueError('Unexpected syntax for ' + value)
            edits.append((tokens[i+1].start(), tokens[i+1].end(), LIMITS[value]))
            if stack[-1] is not None:
                stack[-1]['seen'].add(value)
    if stack or not servers:
        raise ValueError('No complete server block found; configuration not changed.')
    for server in servers:
        missing = [f'    {key} {value};' for key, value in LIMITS.items() if key not in server['seen']]
        if missing:
            edits.append((server['open'], server['open'], '\n' + '\n'.join(missing) + '\n'))
    for start, end, replacement in sorted(edits, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/nginx/sites-available/tryit-elastic'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    target = args.config.resolve(strict=True)
    original = target.read_text()
    updated = updated_limits(original)
    if args.dry_run:
        print(''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True), fromfile='current', tofile='upload-limits')), end='')
        return
    if updated == original:
        print('Nginx upload limits already configured.')
        return
    if os.geteuid() != 0:
        parser.error('Run with sudo to update the Nginx site configuration.')
    nginx = shutil.which('nginx')
    if not nginx:
        parser.error('Nginx is not installed; configuration not changed.')
    backup = target.with_name(target.name + '.before-uploads-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S%f'))
    shutil.copy2(target, backup)
    info = target.stat()
    fd, temporary = tempfile.mkstemp(prefix='.tryit-uploads-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(updated)
        os.chmod(temporary, info.st_mode & 0o777)
        os.chown(temporary, info.st_uid, info.st_gid)
        os.replace(temporary, target)
        if subprocess.run([nginx, '-t']).returncode:
            shutil.copy2(backup, target)
            raise RuntimeError('Nginx validation failed; previous site configuration restored.')
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print('Nginx upload limit set to 120 MB. TLS/proxy settings preserved. Backup: ' + str(backup))

if __name__ == '__main__':
    main()
