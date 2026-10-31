"""Run the whole pipeline end to end, for any airports, with no manual steps.

    python scripts/run_pipeline.py                                  # ATL+DFW trained, ORD held out (default)
    python scripts/run_pipeline.py --train KATL KDFW --holdout KDEN # any ICAO codes
    python scripts/run_pipeline.py --skip-download                  # reuse cached public data

Steps: download public data -> clean provided file (notebook 01) -> Jev reads TAF text (if a key is set)
-> build + execute the modelling notebook (02) -> outputs in data/model/ used by app/server.py.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable
JUP = str(Path(PY).parent / "jupyter")


def step(name, cmd, env):
    t0 = time.time()
    print(f"\n▶ {name}\n  $ {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd, cwd=ROOT, env=env)
    if r.returncode:
        sys.exit(f"✗ {name} failed (exit {r.returncode})")
    print(f"✓ {name} ({time.time() - t0:.0f}s)", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--train", nargs="+", default=["KATL", "KDFW"], help="ICAO codes to train on")
    ap.add_argument("--holdout", nargs="*", default=["KORD"], help="ICAO codes never used in training")
    ap.add_argument("--start", default="2023-01")
    ap.add_argument("--end", default="2025-07")
    ap.add_argument("--skip-download", action="store_true")
    a = ap.parse_args()

    env = {**os.environ, "C5_TRAIN": " ".join(a.train), "C5_HOLDOUT": " ".join(a.holdout)}
    airports = a.train + a.holdout
    run_nb = lambda nb: [JUP, "nbconvert", "--to", "notebook", "--execute", "--inplace",
                         "--ExecutePreprocessor.timeout=7200", nb]
    if not a.skip_download:
        step("Download organisers' files + public data", [PY, "scripts/download_data.py", "--airports", *airports, "--start", a.start, "--end", a.end], env)
    step("Clean the provided dataset", run_nb("01_clean_and_export.ipynb"), env)
    if (ROOT / ".env").exists() or env.get("TYPESAFE_API_KEY"):
        step("Jev reads TAF text (cached, only new texts are sent)", [PY, "scripts/jev_read_tafs.py"], env)
    else:
        print("\n• No TYPESAFE_API_KEY: skipping Jev (models run without the Jev feature group)")
    step("Build modelling notebook", [PY, "scripts/build_model_notebook.py"], env)
    step("Train and evaluate models", run_nb("02_model_capacity_and_delay_risk.ipynb"), env)
    step("Build feature store for scoring your own data", [PY, "scripts/export_feature_store.py"], env)
    step("Light runtime copies for the web app (Vercel)", [PY, "scripts/export_slim_runtime.py"], env)
    print(f"\nDone. Start the app with:  C5_TRAIN='{' '.join(a.train)}' C5_HOLDOUT='{' '.join(a.holdout)}' {PY} app/server.py")


if __name__ == "__main__":
    main()
