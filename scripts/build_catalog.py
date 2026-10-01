"""Build the catalog package from the standalone Desktop files.

Run with --check in CI to reject stale packaged files. Catalog packages use
Hermes updates so their Desktop copy cannot bypass a reviewed commit pin.
"""
import argparse
import json
import subprocess
from pathlib import Path
from catalog_policy import strip_updater

ROOT = Path(__file__).resolve().parent.parent


def bundle_terminal(source):
    # Replace the standalone network loader with the reviewed static dependency.
    # Changed source layout must fail the build rather than retain a CDN fallback.
    start_marker = "function ctorFromModule"
    end_marker = "function measureCell"
    if source.count(start_marker) != 1 or source.count(end_marker) != 1:
        raise ValueError("Unknown xterm loader layout")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    bundled = subprocess.run(
        ["node", "scripts/bundle_xterm.mjs"], cwd=ROOT,
        check=True, capture_output=True, text=True, encoding="utf-8",
    ).stdout
    loader = """async function loadTerminal() {
  if (typeof TerminalCtor === 'function') return TerminalCtor
  injectXtermCss()
  TerminalCtor = createCatalogTerminal()
  return TerminalCtor
}

"""
    return bundled + source[:start] + loader + source[end:]


def build(check=False):
    config = json.loads((ROOT / "catalog-package.json").read_text())
    name = config["name"]
    source = strip_updater((ROOT / "plugin.js").read_text(encoding="utf-8"), config["updater"])

    source = bundle_terminal(source)

    manifest = {
        "name": name, "version": config["version"],
        "description": config["description"], "author": "Adolanium",
        "manifest_version": 1, "kind": "standalone",
        "provides_tools": [], "provides_hooks": [],
        "provides_middleware": [], "requires_env": [],
    }
    # JSON is valid YAML and needs no Python YAML dependency.
    outputs = {
        "catalog/plugin.yaml": json.dumps(manifest, indent=2) + "\n",
        "catalog/__init__.py": '"""Desktop package. Electron loads desktop/plugin.js."""\n\n\ndef register(ctx):\n    """No Agent tools or hooks; enable the Desktop component in Capabilities."""\n',
        "catalog/desktop/plugin.js": source,
        "catalog/THIRD_PARTY_NOTICES.md": "# Bundled terminal dependency\n\n@xterm/xterm 5.5.0 (MIT) is statically bundled into desktop/plugin.js.\n\n" + (ROOT / "node_modules/@xterm/xterm/LICENSE").read_text(encoding="utf-8"),
    }
    for companion in config["companions"]:
        outputs["catalog/desktop/" + companion] = (ROOT / companion).read_text(encoding="utf-8")
    stale = []
    for name, content in outputs.items():
        target = ROOT / name
        if check:
            if not target.is_file() or target.read_text(encoding="utf-8") != content:
                stale.append(name)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8", newline="\n")
    if stale:
        raise SystemExit("Run python scripts/build_catalog.py; stale files: " + ", ".join(stale))
    print("Catalog package verified" if check else "Catalog package built")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    build(parser.parse_args().check)
