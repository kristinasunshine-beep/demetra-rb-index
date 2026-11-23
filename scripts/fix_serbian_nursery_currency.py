#!/usr/bin/env python3
"""Retired historical migration. Never rewrite later EUR supplier inputs."""
import json

if __name__ == "__main__":
    print(json.dumps({"enabled": False, "skipped": True,
                      "reason": "Istorijska migracija je završena; nove cene su u EUR. Nijedna datoteka nije promenjena."}, ensure_ascii=True))
