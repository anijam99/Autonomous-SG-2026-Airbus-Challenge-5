"""Vercel entry point: the FastAPI app from app/server.py (also serves the front end)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from server import app  # noqa: E402,F401
