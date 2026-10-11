import tempfile
import unittest
from pathlib import Path

from set_ollama_host import set_host


class HostEditorTest(unittest.TestCase):
    def test_preservation_idempotence_and_rollback(self):
        fixtures = [
            '[Service]\n# OLLAMA_HOST=leave-comment\n'
            'Environment="OLLAMA_HOST=0.0.0.0:11434"\n'
            'Environment="OLLAMA_MODELS=/srv/factory/models"\n'
            'Environment="OLLAMA_FLASH_ATTENTION=1" "OLLAMA_KV_CACHE_TYPE=q8_0"\n',
            '[Service]\r\nEnvironment=OTHER=OLLAMA_HOST=untouched OLLAMA_HOST=0.0.0.0:11434\r\n',
            '[Service]\nEnvironment="OTHER=text OLLAMA_HOST=untouched" "OLLAMA_HOST=0.0.0.0:11434"\n',
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "override.conf"
            for original in fixtures:
                path.write_bytes(original.encode())
                set_host(path, "127.0.0.1:11435")
                expected = original.replace("OLLAMA_HOST=0.0.0.0:11434", "OLLAMA_HOST=127.0.0.1:11435")
                self.assertEqual(path.read_bytes(), expected.encode())
                set_host(path, "127.0.0.1:11435")
                self.assertEqual(path.read_bytes(), expected.encode())
                set_host(path, "0.0.0.0:11434")
                self.assertEqual(path.read_bytes(), original.encode())
            path.write_bytes(b"[Service]\nEnvironment=OLLAMA_MODELS=/srv/factory/models")
            set_host(path, "127.0.0.1:11435")
            self.assertEqual(path.read_bytes(), b'[Service]\nEnvironment=OLLAMA_MODELS=/srv/factory/models\n[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11435"\n')


if __name__ == "__main__":
    unittest.main()
