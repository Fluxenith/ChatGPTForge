"""Launch the independent pinned Skills Manager with explicit Forge-owned state."""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
from pathlib import Path
from forge_skills_migrations import migration_guard


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["headless", "manager", "import", "status"])
    parser.add_argument("--profile", type=Path, required=True)
    args = parser.parse_args()
    profile = json.loads(args.profile.read_text(encoding="utf-8-sig"))
    if profile.get("version") != 1:
        raise ValueError("Unsupported Skills service profile")
    source = Path(profile["source_dir"]).resolve(strict=True)
    head = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if head != profile["source_head"]:
        raise ValueError("Skills Manager source version changed")
    dirty = subprocess.check_output(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
        text=True,
    ).strip()
    if dirty:
        raise ValueError("Skills Manager tracked source changed")
    sys.path.insert(0, str(source / "src"))
    from skill_control_plane.core import Registry, SourceRoot
    from skill_control_plane.registry_store import RegistryStore
    from skill_control_plane.storage import ControlPlaneDB
    from skill_control_plane.workflow import WorkflowService

    roots = []
    for entry in profile["roots"]:
        path = Path(entry["path"])
        if not path.is_absolute() or path.is_symlink():
            raise ValueError("Skills roots must be explicit absolute directories")
        path = path.resolve(strict=True)
        if not path.is_dir():
            raise ValueError("Skills root is not a directory")
        roots.append(SourceRoot(entry["source_class"], path, entry["authority_tier"]))
    state = Path(profile["state_dir"])
    if not state.is_absolute() or state.is_symlink():
        raise ValueError("Skills state must be an explicit absolute directory")
    state.mkdir(parents=True, exist_ok=True)
    registry = Registry(roots, index_path=state / "index.json")
    db_path = state / "control-plane.db"
    snapshot = registry.payload(force=True)
    with migration_guard(profile), ControlPlaneDB(db_path) as db:
        RegistryStore(db).reconcile(snapshot)
        if args.mode == "import":
            service = WorkflowService(db)
            imported = []
            receipt_file = state / "workflow-imports.json"
            receipts = json.loads(receipt_file.read_text(encoding="utf-8")) if receipt_file.exists() else {}
            for name in profile["workflow_files"]:
                path = Path(name).resolve(strict=True)
                raw = path.read_bytes()
                spec = json.loads(raw.decode("utf-8"))
                spec_hash = hashlib.sha256(raw).hexdigest()
                # Upstream deterministic IDs make an identical import idempotent.
                from skill_control_plane.utils import stable_id
                workflow_id = stable_id("wf", str(spec["name"]), int(spec["version"]))
                existing = db.connection.execute(
                    "SELECT 1 FROM workflows WHERE workflow_id=?", (workflow_id,)
                ).fetchone()
                if existing is not None:
                    receipt = receipts.get(workflow_id)
                    def immutable_contract(workflow):
                        return {key: value for key, value in workflow.items() if key not in {"archived", "created_at", "updated_at"}}
                    if receipt is None or receipt["sha256"] != spec_hash or immutable_contract(receipt["workflow"]) != immutable_contract(service.get_workflow(workflow_id)):
                        raise ValueError("Existing workflow has no matching import receipt; inspect it before changing versions")
                else:
                    service.create_workflow(spec)
                    receipts[workflow_id] = {"sha256": spec_hash, "workflow": service.get_workflow(workflow_id)}
                    temporary = receipt_file.with_suffix(".tmp")
                    temporary.write_text(json.dumps(receipts, ensure_ascii=False, indent=2), encoding="utf-8")
                    os.replace(temporary, receipt_file)
                imported.append(workflow_id)
            print(json.dumps({"source_head": head, "workflow_ids": imported}))
            return
        if args.mode == "status":
            print(json.dumps({"source_head": head, "registry": registry.status(), "parity": RegistryStore(db).parity(snapshot), "integrity": db.integrity()}))
            return
    if args.mode == "headless":
        from skill_control_plane import server as headless
        # Upstream resource/resolve handlers still reference this default directly.
        # Configure it to the same persistent database used by all other handlers.
        headless.DEFAULT_DB = db_path
        # Forge launch-layer tool: expose the engine's own stage-failure
        # transition (retry, fallback skill, fallback stage, run failure).
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "forge_skills_extensions", Path(__file__).resolve().with_name("forge_skills_extensions.py")
        )
        extensions = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(extensions)
        extensions.install(headless)
        headless.serve(registry, "127.0.0.1", 8943, db_path=db_path)
    else:
        # Windows registry MIME overrides can label JavaScript as text/plain;
        # the upstream UI uses nosniff, so Chrome correctly refuses those files.
        mimetypes.init()
        mimetypes.add_type("text/javascript", ".js")
        mimetypes.add_type("text/javascript", ".mjs")
        from skill_control_plane.web_manager import create_server
        server = create_server("127.0.0.1", 8955, registry=registry, db_path=db_path, web_root=source / "web" / "manager")
        try:
            server.serve_forever(poll_interval=0.25)
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
