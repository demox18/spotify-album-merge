import { spawnSync } from 'node:child_process';

const code = `
import os, zipfile
root = "dist"
out = "dist.zip"
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for dirpath, _, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            archive.write(full, os.path.relpath(full, root))
print("wrote", out)
`;

const result = spawnSync('python3', ['-c', code], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
