"""Create a distributable source ZIP without local databases, credentials or Git internals."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
output = root / 'artifacts' / 'hakaton2-mvp.zip'
output.parent.mkdir(parents=True,exist_ok=True)
excluded = {'.git','__pycache__','data','.runtime','node_modules'}
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if not path.is_file() or any(part in excluded for part in relative.parts):
            continue
        if path.suffix in ('.zip','.sqlite3','.pyc','.log') or path.name.startswith('.env') or '.sqlite3-' in path.name:
            continue
        archive.write(path,'hakaton2-mvp/' + relative.as_posix())
print(output)
