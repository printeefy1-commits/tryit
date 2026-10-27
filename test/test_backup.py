import importlib.util
import json
import tempfile
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('backup', Path(__file__).resolve().parents[1] / 'scripts/backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        (self.project / 'data/sessions').mkdir(parents=True)
        (self.project / 'uploads').mkdir()
        self.products = [{'id': 'test', 'image': '/uploads/photo.png', 'model': '/uploads/model.glb'}]
        (self.project / 'data/catalog.json').write_text(json.dumps(self.products))
        (self.project / 'data/sessions/session.json').write_text('exclude sessions')
        (self.project / 'uploads/photo.png').write_bytes(b'image bytes')
        (self.project / 'uploads/model.glb').write_bytes(b'model bytes')
        (self.project / 'uploads/unreferenced.png').write_bytes(b'unused')
        self.settings = self.root / 'tryit.env'
        self.settings.write_text('TEST_SETTING=fixture-only\n')

    def test_restore_snapshot_with_settings_and_without_sessions(self):
        archive = backup.create(self.project, self.root / 'backups', [self.settings])
        backup.verify(archive)
        destination = self.root / 'restore'
        with tarfile.open(archive) as tar:
            tar.extractall(destination, filter='data')
        snapshot = destination / 'snapshot'
        self.assertEqual(json.loads((snapshot / 'data/catalog.json').read_text()), self.products)
        self.assertEqual((snapshot / 'uploads/model.glb').read_bytes(), b'model bytes')
        self.assertEqual((snapshot / 'uploads/photo.png').read_bytes(), b'image bytes')
        self.assertEqual((snapshot / 'settings/0/tryit.env').read_bytes(), self.settings.read_bytes())
        self.assertFalse((snapshot / 'data/sessions').exists())
        self.assertFalse((snapshot / 'uploads/unreferenced.png').exists())
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((snapshot / 'manifest.json').read_text())['upload_count'], 2)

    def test_corruption_is_rejected(self):
        archive = backup.create(self.project, self.root / 'backups')
        with archive.open('ab') as out:
            out.write(b'corruption')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            backup.verify(archive)

    def test_missing_referenced_upload_prevents_success(self):
        (self.project / 'uploads/model.glb').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing or unsafe'):
            backup.create(self.project, self.root / 'backups')
        self.assertEqual(list((self.root / 'backups').glob('*.tar.gz')), [])

    def test_traversal_and_symlink_are_rejected(self):
        for value in ['/uploads/../tryit.env', '/etc/passwd']:
            (self.project / 'data/catalog.json').write_text(json.dumps([{'image': value}]))
            with self.assertRaises(ValueError):
                backup.create(self.project, self.root / 'backups')
        (self.project / 'uploads/link.png').symlink_to(self.settings)
        (self.project / 'data/catalog.json').write_text(json.dumps([{'image': '/uploads/link.png'}]))
        with self.assertRaises(ValueError):
            backup.create(self.project, self.root / 'backups')

if __name__ == '__main__':
    unittest.main()
