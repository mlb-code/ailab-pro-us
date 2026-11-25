"""The database builds a new FirstRing tenant's time zone from the area code (private.area_code_tz in
supabase/migrations/*_us_subscriptions.sql); it must say exactly what app/area_codes.py says."""
from __future__ import annotations

import re
from pathlib import Path

from app.area_codes import AREA_TZ

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def test_sql_area_code_table_equals_the_runtime_table():
    sql = next(MIGRATIONS.glob("*_us_subscriptions.sql")).read_text(encoding="utf-8")
    body = sql.split("create or replace function private.area_code_tz", 1)[1].split("end $$;", 1)[0]
    got = {}
    for arr, tz in re.findall(r"when v_ac = any\(array\[([^\]]+)\]\) then '([^']+)'", body):
        for code in re.findall(r"'(\d{3})'", arr):
            got[code] = tz
    assert got == AREA_TZ
