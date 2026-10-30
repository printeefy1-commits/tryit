#!/usr/bin/env python3
"""Snapshot the catalogue and referenced immutable uploads; optionally upload to S3."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import uuid


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def create(project, output, settings=()):
    project, output = Path(project).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Catalogue writes are atomic renames; uploaded UUID files are never modified
    # or deleted by the application. Read the catalogue once, then copy its files.
    raw = (project / 'data/catalog.json').read_bytes()
    products = json.loads(raw)
    if not isinstance(products, list):
        raise ValueError('Invalid catalogue')
    name = 'lunette-caba-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    archive = output / (name + '.tar.gz')
    with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=output) as temporary:
        stage = Path(temporary) / 'snapshot'
        (stage / 'data').mkdir(parents=True)
        (stage / 'uploads').mkdir()
        (stage / 'data/catalog.json').write_bytes(raw)
        referenced = set()
        for product in products:
            gallery = product.get('images', [])
            if not isinstance(gallery, list):
                raise ValueError('Invalid product photo gallery')
            for value in [product.get('image'), product.get('model'), product.get('modelOriginal'), *gallery]:
                if not value:
                    continue
                if not isinstance(value, str):
                    raise ValueError('Unsafe upload reference')
                relative = PurePosixPath(value)
                if not value.startswith('/uploads/') or len(relative.parts) != 3 or relative.name in ('.', '..') or '\\' in value:
                    raise ValueError('Unsafe upload reference')
                source = project / 'uploads' / relative.name
                if source.is_symlink() or not source.is_file():
                    raise ValueError('Missing or unsafe referenced upload: ' + relative.name)
                if relative.name not in referenced:
                    shutil.copyfile(source, stage / 'uploads' / relative.name)
                    referenced.add(relative.name)
                    if relative.suffix == '.glb':
                        for suffix in ('.br', '.gz'):
                            sidecar = source.with_name(source.name + suffix)
                            if sidecar.is_symlink():
                                raise ValueError('Unsafe compressed model reference')
                            if sidecar.is_file():
                                shutil.copyfile(sidecar, stage / 'uploads' / sidecar.name)
                                referenced.add(sidecar.name)
        settings_map = []
        for index, source in enumerate(map(Path, settings)):
            if not source.is_file():
                raise ValueError('Missing settings file: ' + str(source))
            destination = stage / 'settings' / str(index) / source.name
            destination.parent.mkdir(parents=True)
            shutil.copyfile(source, destination)
            settings_map.append({'original_path': str(source.resolve()), 'archive_path': str(destination.relative_to(stage))})
        commit = subprocess.run(['git', '-C', str(project), 'rev-parse', 'HEAD'], capture_output=True, text=True)
        manifest = {'format': 1, 'created_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'commit': commit.stdout.strip() if commit.returncode == 0 else None,
                    'product_count': len(products), 'upload_count': len(referenced), 'settings': settings_map}
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        pending = Path(temporary) / 'archive.tar.gz'
        with tarfile.open(pending, 'w:gz') as tar:
            tar.add(stage, arcname='snapshot')
        os.chmod(pending, 0o600)
        pending.replace(archive)
    checksum = digest(archive)
    sidecar = archive.with_name(archive.name + '.sha256')
    sidecar.write_text(checksum + '  ' + archive.name + '\n')
    os.chmod(sidecar, 0o600)
    return archive


def verify(archive):
    archive = Path(archive)
    expected = archive.with_name(archive.name + '.sha256').read_text().split()[0]
    if digest(archive) != expected:
        raise ValueError('Backup checksum mismatch')
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or name.parts[0] != 'snapshot' or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe archive member')
        json.load(tar.extractfile('snapshot/manifest.json'))
        json.load(tar.extractfile('snapshot/data/catalog.json'))
    return expected


def upload(archive, bucket, region):
    uri = f's3://{bucket}/daily/{archive.name}'
    command = ['aws', '--region', region, 's3', 'cp']
    subprocess.run(command + [str(archive), uri, '--sse', 'AES256', '--checksum-algorithm', 'SHA256', '--only-show-errors'], check=True)
    # Verify the actual remote bytes, including multipart uploads, before declaring success.
    remote = subprocess.Popen(command + [uri, '-', '--only-show-errors'], stdout=subprocess.PIPE)
    checksum = hashlib.file_digest(remote.stdout, 'sha256').hexdigest()
    remote.stdout.close()
    if remote.wait() != 0 or checksum != digest(archive):
        raise ValueError('Remote S3 verification failed')
    sidecar = str(archive) + '.sha256'
    subprocess.run(command + [sidecar, uri + '.sha256', '--sse', 'AES256', '--only-show-errors'], check=True)
    print('S3 backup uploaded and verified: ' + uri)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    new = commands.add_parser('create')
    new.add_argument('--project', type=Path, required=True)
    new.add_argument('--output', type=Path, required=True)
    new.add_argument('--settings', action='append', default=[])
    new.add_argument('--bucket')
    new.add_argument('--region', default='eu-north-1')
    commands.add_parser('verify').add_argument('archive', type=Path)
    args = parser.parse_args()
    if args.action == 'verify':
        verify(args.archive)
        print('Backup checksum and archive structure verified.')
        return
    archive = create(args.project, args.output, args.settings)
    verify(archive)
    if args.bucket:
        upload(archive, args.bucket, args.region)
        # Successful backups live off-instance. Failed uploads retain their local archive.
        archive.unlink()
        archive.with_name(archive.name + '.sha256').unlink()
    else:
        print('Local backup verified: ' + str(archive))


if __name__ == '__main__':
    main()
