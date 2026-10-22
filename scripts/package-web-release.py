"""Package a complete app at a new URL, independent of cached root app resources."""
import json
import re
import shutil
from pathlib import Path

project = Path(__file__).resolve().parent.parent
root = project / "artifacts/web/wwwroot"
source = (project / "src/EmlToPst.Web/AppVersion.cs").read_text(encoding="utf-8")
match = re.search(r'public const string Id = "([a-z0-9-]+)";', source)
if not match:
    raise SystemExit("AppVersion.Id must be a lower-case release path segment")
version = match.group(1)
manifest = {"version": version, "path": f"releases/{version}/"}
(root / "release.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
release = root / manifest["path"]
if release.exists():
    shutil.rmtree(release)
# Exclude previous releases to prevent nesting them inside the new release.
shutil.copytree(root, release, ignore=shutil.ignore_patterns("releases"))
if not (release / "_framework").is_dir() or not (release / "index.html").is_file():
    raise SystemExit("Incomplete standalone browser release")
print(f"Packaged standalone release: {manifest['path']}")
