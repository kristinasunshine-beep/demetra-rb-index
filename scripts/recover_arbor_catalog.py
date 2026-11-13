#!/usr/bin/env python3
"""Recover omitted fields from the reviewed Arbor stock list, never add records.

This one-time repair is pinned to the verified 2026-04-15 XLSX SHA256. Matching
uses only whitespace-normalized Product and NEW INPOT cell text. No fuzzy names,
outgoing company offers, currency assumptions or generic dimension inference.
"""
from __future__ import annotations

import argparse
import copy
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import tempfile
from xml.etree import ElementTree as ET
from zipfile import ZipFile

SOURCE_DATE = "2026-04-15"
SOURCE_SHA256 = "5eeb7b29f262f935bc058dece14394aef2bf3882f9194e03501bd5e29f980ba1"
SHEET_NAME = "Sheet1"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
NO_CURRENCY_NOTE = "Valuta nije navedena u izvornom cenovniku; iznos je prenet bez konverzije."
ZERO_NOTE = "U izvornom cenovniku navedena je vrednost 0; stvarna prodajna cena nije potvrđena."
NO_LENGTH_UNIT_NOTE = "Jedinica dužine nije navedena u izvoru."
POT = re.compile(r"\bC(\d+(?:[.,]\d+)?)L\b", re.I)
RANGE = re.compile(r"(?<![\w.])(\d+(?:[.,]\d+)?)\s*([-–/])\s*(\d+(?:[.,]\d+)?)(?![\w.])")
SHAPED = re.compile(r"\b(?:STD|BALL|ROOF|POM\w*|HEAD|BONSAI|UMBRELLA|PLEACHED|SCREEN|CONE|SPIRAL|TOPIARY|STEM|MULTISTEM|ART|SHAPED|ARCH\w*|CUBE|BLOCK)\b", re.I)
EXPLICIT = re.compile(r"(?<![A-Za-z])(?P<label>HT|H|B)\s*=\s*(?P<value>\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?)(?:\s*(?P<unit>cm|mm|m))?(?=\s|$|[;,])", re.I)


class RepairError(ValueError):
    pass


def whitespace(value):
    return " ".join(str(value or "").split())


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def number(value):
    n = Decimal(str(value).replace(",", "."))
    if not n.is_finite():
        raise InvalidOperation
    return n


def json_number(value):
    return int(value) if value == value.to_integral_value() else float(value)


def displayed_number(value):
    text = format(number(value), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text.replace(".", ",")


@dataclass(frozen=True)
class SourceRow:
    row: int
    product: str
    new_inpot: str
    amount: Decimal | None
    amount_raw: str
    price_status: str

    def signature(self):
        # Stock quantities, locations and barcodes are not copied. All fields
        # that determine the imported product/specification/price must agree.
        return (whitespace(self.product), whitespace(self.new_inpot), self.amount, self.price_status)


@dataclass
class Source:
    filename: str
    sha256: str
    rows: list[SourceRow]
    sheet: str = SHEET_NAME


def xml_value(cell, shared):
    if cell is None:
        return ""
    raw = cell.findtext("m:v", default="", namespaces=NS)
    if cell.get("t") == "s":
        return shared[int(raw)]
    if cell.get("t") == "inlineStr":
        return "".join(t.text or "" for t in cell.findall(".//m:t", NS))
    return raw


def parse_sheet(xml, shared):
    sheet = ET.fromstring(xml)
    raw_rows = sheet.findall("m:sheetData/m:row", NS)
    header = next((r for r in raw_rows if r.get("r") == "1"), None)
    if header is None:
        raise RepairError("Reviewed header row is absent.")
    headers = {re.sub(r"\d+", "", c.get("r", "")): whitespace(xml_value(c, shared)) for c in header.findall("m:c", NS)}
    if any(headers.get(k) != v for k, v in {"B": "Product", "C": "NEW INPOT", "E": "sales price"}.items()):
        raise RepairError("Source column labels differ from the reviewed Arbor stock list.")
    result = []
    for row in raw_rows:
        index = int(row.get("r", "0"))
        if index <= 1:
            continue
        cells = {re.sub(r"\d+", "", c.get("r", "")): c for c in row.findall("m:c", NS)}
        product = xml_value(cells.get("B"), shared)
        if not whitespace(product):
            continue
        price_cell = cells.get("E")
        raw = xml_value(price_cell, shared)
        amount, status = None, "missing"
        if price_cell is not None and price_cell.find("m:f", NS) is not None:
            status = "formula_not_evaluated"
        elif price_cell is not None and raw != "":
            if price_cell.get("t") not in {None, "n"}:
                status = "not_numeric_cell"
            else:
                try:
                    amount = number(raw)
                    status = "positive" if amount > 0 else "zero" if amount == 0 else "negative"
                except (InvalidOperation, ValueError):
                    status = "invalid_number"
        result.append(SourceRow(index, product, xml_value(cells.get("C"), shared), amount, raw, status))
    return result


def read_source(path):
    path = Path(path)
    contents = path.read_bytes()
    digest = sha256(contents)
    if digest != SOURCE_SHA256:
        raise RepairError("XLSX SHA256 differs from the reviewed 2026-04-15 source; no catalogue changes made.")
    with ZipFile(path) as book:
        shared = []
        if "xl/sharedStrings.xml" in book.namelist():
            shared = ["".join(t.text or "" for t in entry.findall(".//m:t", NS)) for entry in ET.fromstring(book.read("xl/sharedStrings.xml")).findall("m:si", NS)]
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))}
        sheets = ET.fromstring(book.read("xl/workbook.xml")).findall("m:sheets/m:sheet", NS)
        matches = [s for s in sheets if s.get("name") == SHEET_NAME]
        if len(matches) != 1:
            raise RepairError("Reviewed worksheet Sheet1 is absent or ambiguous.")
        target = rels[matches[0].get("{" + NS["r"] + "}id")]
        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        return Source(path.name, digest, parse_sheet(book.read(target), shared))


def parse_specification(value):
    if not isinstance(value, str) or not value.startswith("Product:"):
        return None
    body = value[len("Product:"):]
    parts = re.split(r";\s*NEW INPOT:\s*", body)
    if len(parts) > 2:
        return None
    product = whitespace(parts[0])
    # The original exporter omitted the C field only when its cell was empty.
    new_inpot = whitespace(parts[1]) if len(parts) == 2 else ""
    return (product, new_inpot) if product else None


def source_measurements(product):
    """Return explicit labels and narrow, separately evidenced trade-size rules."""
    fields, rules, notes = {}, {}, []
    pots = {number(m.group(1)) for m in POT.finditer(product)}
    if len(pots) == 1 and next(iter(pots)) > 0:
        litres = next(iter(pots))
        fields["potSize"] = f"{displayed_number(litres)} L"
        rules["potSize"] = "explicit_C_number_L"
        if not re.search(r"\b(?:RB|BR)\b", product, re.I):
            fields["rootType"] = "Kontejner"
            rules["rootType"] = "explicit_container_without_RB_or_BR"
    elif len(pots) > 1:
        notes.append("multiple_container_volumes_not_assigned")
    labels = defaultdict(list)
    for match in EXPLICIT.finditer(product):
        field = "height" if match.group("label").upper() in {"H", "HT"} else "crownWidth"
        val = re.sub(r"\s*[-–]\s*", "–", match.group("value"))
        unit = match.group("unit")
        labels[field].append((val + (" " + unit.lower() if unit else ""), bool(unit)))
    missing_unit = False
    # STD stock rows describe a standard tree: the immediately preceding
    # small range is its girth class. Do not copy the range into height, take
    # a range elsewhere in the name, or append a unit absent from the row.
    standard_sizes = list(re.finditer(
        r"(?<![\w.\-/])(?P<lo>\d{1,2})\s*[-–/]\s*(?P<hi>\d{1,3})(?:\s*(?P<unit>cm))?\s+STD\b",
        product, re.I))
    if len(standard_sizes) == 1:
        size = standard_sizes[0]
        lo, hi = int(size.group('lo')), int(size.group('hi'))
        if 2 <= lo < hi <= 100:
            unit = ' cm' if size.group('unit') else ''
            fields['circumference'] = f'{lo}–{hi}{unit}'
            rules['circumference'] = 'single_small_range_immediately_before_STD_no_unit_assumed'
            missing_unit = not bool(unit)
    for field, values in labels.items():
        if len(set(values)) == 1:
            value, has_unit = values[0]
            fields[field] = value
            rules[field] = "explicit_H_or_HT_equals" if field == "height" else "explicit_B_equals"
            missing_unit = missing_unit or not has_unit
        else:
            notes.append("conflicting_explicit_" + field)
    if "height" not in fields and not labels.get("height"):
        ranges = list(RANGE.finditer(product))
        if re.match(r"^(?:Abies|Picea|Pinus)\s", product) and not SHAPED.search(product) and len(ranges) == 1:
            item = ranges[0]
            lo, hi = number(item.group(1)), number(item.group(3))
            if item.group(2) in {"-", "–"} and 200 <= lo < hi <= 2000:
                fields["height"] = f"{displayed_number(lo)}–{displayed_number(hi)}"
                rules["height"] = "single_large_range_natural_conifer_minimum_200_no_unit_assumed"
                missing_unit = True
    if missing_unit:
        notes.append(NO_LENGTH_UNIT_NOTE)
    return fields, rules, notes


def merge_note(existing, note):
    value = str(existing or "").strip()
    if note in value:
        return value
    return (value + " " + note).strip()


def recover(document, source, now=None, dry_run=False):
    if not isinstance(document, dict) or document.get("schemaVersion") != 1 or not isinstance(document.get("offers"), list):
        raise RepairError("Expected catalogue schemaVersion 1 with offers array.")
    offers = document["offers"]
    if any(not isinstance(o, dict) or not isinstance(o.get("id"), str) for o in offers) or len({o["id"] for o in offers}) != len(offers):
        raise RepairError("Existing catalogue has invalid or duplicate offer IDs.")
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    lookup = defaultdict(list)
    for row in source.rows:
        lookup[(whitespace(row.product), whitespace(row.new_inpot))].append(row)
    output = copy.deepcopy(document)
    counts, changed_fields = Counter(), Counter()
    details = []
    public_before = {o["id"]: o for o in offers if o.get("priceKind") == "public" and o.get("price") is not None}
    for old, updated in zip(offers, output["offers"]):
        if old.get("nurseryId") != "arbor":
            continue
        counts["arborRecords"] += 1
        if old.get("sourceDate") != SOURCE_DATE or old.get("priceKind") != "historical":
            counts["outsideSourceDateOrKind"] += 1
            continue
        parsed = parse_specification(old.get("specification"))
        if parsed is None:
            counts["invalidSpecification"] += 1
            details.append({"offerId": old["id"], "status": "skipped", "reason": "specification_structure_not_recognized"})
            continue
        counts["eligible"] += 1
        product, new_inpot = parsed
        entry = {"offerId": old["id"], "product": product, "newInpot": new_inpot}
        matches = lookup.get(parsed, [])
        if not matches:
            counts["unmatched"] += 1
            entry.update(status="skipped", reason="no_exact_Product_and_NEW_INPOT_match")
            details.append(entry)
            continue
        source_rows = sorted(r.row for r in matches)
        entry["sourceRows"] = source_rows
        if len({r.signature() for r in matches}) != 1:
            counts["conflictingDuplicates"] += 1
            entry.update(status="skipped", reason="same_Product_and_NEW_INPOT_have_conflicting_price_data")
            details.append(entry)
            continue
        row = min(matches, key=lambda r: r.row)
        if row.price_status not in {"positive", "zero"}:
            counts["unsupportedPrice"] += 1
            entry.update(status="skipped", reason="source_price_" + row.price_status)
            details.append(entry)
            continue
        counts["matched"] += 1
        counts["agreeingDuplicateMatches" if len(matches) > 1 else "uniqueMatches"] += 1
        if new_inpot:
            counts["matchedExplicitNewInpot"] += 1
        owner_proof = old.get('currencyEvidence') or {}
        confirmed_eur = (
            old.get('currency') == 'EUR' and old.get('sourceCurrency', 'EUR') == 'EUR' and
            isinstance(owner_proof, dict) and owner_proof.get('origin') == 'catalogue_owner_confirmation' and
            owner_proof.get('reference') == 'docs/currency-confirmation.json'
        )
        # This workbook has no currency marker. Retain an existing owner EUR
        # confirmation; otherwise keep currency unknown, never infer it from FX.
        for field in ('priceConversion', 'priceRefresh', 'priceObservation', 'sourceCurrencyEvidence'):
            updated.pop(field, None)
        if not confirmed_eur:
            updated.pop('currencyEvidence', None)
        updated["price"] = json_number(row.amount) if row.price_status == "positive" else None
        updated['sourceAmount'] = updated['price']
        updated['sourceCurrency'] = 'EUR' if confirmed_eur else ''
        updated["currency"] = 'EUR' if confirmed_eur else ''
        updated['currencyStatus'] = 'owner_confirmed' if confirmed_eur else 'not_stated'
        updated['sourceCurrencyEvidence'] = copy.deepcopy(owner_proof) if confirmed_eur else {
            'origin': 'original_workbook_currency_not_stated', 'sourceSha256': source.sha256,
            'sheet': source.sheet, 'priceCell': f'E{row.row}'}
        updated["priceKind"] = "historical"
        updated["priceNote"] = ('Cena iz arhivirane ponude; valuta EUR potvrđena od strane vlasnika kataloga.' if confirmed_eur else NO_CURRENCY_NOTE) if row.price_status == "positive" else ZERO_NOTE
        if row.price_status == "positive":
            counts["positiveAmounts"] += 1
        else:
            counts["zeroAmountsLeftNull"] += 1
        updated["priceEvidence"] = {"sourceFile": source.filename, "sourceSha256": source.sha256, "sheet": source.sheet, "row": row.row, "priceCell": f"E{row.row}", "amount": json_number(row.amount), "rawAmount": row.amount_raw, "sourceRows": source_rows, "matchingColumns": ["B: Product", "C: NEW INPOT"], "currencyStatus": "not_stated", "sourcePriceStatus": row.price_status}
        measures, rules, measurement_notes = source_measurements(row.product)
        applied_rules = {}
        for field, val in measures.items():
            existing = str(old.get(field) or "").strip()
            # Preserve populated dimensions unless merely expanding the same
            # literal C-volume to its explicit litre unit.
            safe_old_pot = field == "potSize" and bool(POT.fullmatch(existing)) and source_measurements(existing)[0].get("potSize") == val
            if not existing or existing == val or safe_old_pot:
                updated[field] = val
                applied_rules[field] = rules[field]
            else:
                entry.setdefault("preservedMeasurementFields", []).append(field)
        if any(k in applied_rules for k in ["height", "crownWidth", "circumference"]) and NO_LENGTH_UNIT_NOTE in measurement_notes:
            updated["measurementNote"] = merge_note(old.get("measurementNote"), NO_LENGTH_UNIT_NOTE)
        if applied_rules:
            updated["measurementEvidence"] = {"sourceFile": source.filename, "sourceSha256": source.sha256, "sheet": source.sheet, "productCell": f"B{row.row}", "sourceRows": source_rows, "rules": applied_rules}
        non_unit_notes = [n for n in measurement_notes if n != NO_LENGTH_UNIT_NOTE]
        if non_unit_notes:
            entry["measurementWarnings"] = non_unit_notes
        changed = sorted(k for k in set(old) | set(updated) if old.get(k) != updated.get(k))
        if changed:
            counts["changedRecords"] += 1
            changed_fields.update(changed)
        else:
            counts["unchangedRecords"] += 1
        entry.update(status="would_change" if changed and dry_run else "changed" if changed else "unchanged", sourcePriceStatus=row.price_status, changedFields=changed, measurementRules=applied_rules)
        details.append(entry)
    if counts["changedRecords"]:
        output["updatedAt"] = now
    public_after = {o["id"]: o for o in output["offers"] if o.get("priceKind") == "public" and o.get("price") is not None}
    if public_after != public_before or len(output["offers"]) != len(offers) or [o["id"] for o in output["offers"]] != [o["id"] for o in offers]:
        raise RepairError("Scope preservation failed; no output may be written.")
    report = {"schemaVersion": 1, "operation": "recover_reviewed_arbor_stock_2026_04_15", "runAt": now, "dryRun": bool(dry_run), "source": {"file": source.filename, "sha256": source.sha256, "sheet": source.sheet, "sourceDate": SOURCE_DATE, "productRows": len(source.rows), "priceColumn": "E", "priceHeader": "sales price", "currencyStatus": "not_stated", "priceCounts": dict(Counter(r.price_status for r in source.rows))}, "counts": dict(counts), "changedFieldCounts": dict(changed_fields), "publicPricedRecordsPreserved": len(public_before), "offersBefore": len(offers), "offersAfter": len(output["offers"]), "newOffers": 0, "newPlants": 0, "newNurseries": 0, "dataChanged": output != document, "matching": {"normalization": "whitespace_only", "keys": ["Product", "NEW INPOT"], "absentNewInpotSuffixRequiresEmptySourceCell": True, "duplicateAgreement": ["Product", "NEW INPOT", "numeric_price", "price_status"], "quantitiesLocationsBarcodesNotImported": True}, "measurementRules": {"potSize": "Explicit C<number>L only; converted to litres.", "rootType": "Kontejner only with explicit C<number>L and no RB/BR marker.", "height": "Explicit H=/HT= or a single hyphenated 200–2000 range for Abies/Picea/Pinus without listed shaped-form markers; no length unit assumed.", "crownWidth": "Explicit B= only.", "circumference": "Single small range immediately before STD; no length unit assumed.", "rootBall": "No inferred root-ball dimensions."}, "records": details}
    return output, report


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="The unchanged reviewed Arbor XLSX.")
    parser.add_argument("--data", required=True, help="Existing data/kataloske-stavke.json.")
    parser.add_argument("--report", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    written = False
    try:
        paths = [Path(p).resolve() for p in [args.source, args.data, args.report]]
        if len(set(paths)) != 3:
            raise RepairError("Source, catalogue and report paths must differ.")
        source = read_source(args.source)
        original_bytes = Path(args.data).read_bytes()
        original = json.loads(original_bytes)
        result, report = recover(original, source, dry_run=args.dry_run)
        report["inputSha256"] = sha256(original_bytes)
        if not args.dry_run and report["dataChanged"]:
            if Path(args.data).read_bytes() != original_bytes:
                raise RepairError("Catalogue changed concurrently; rerun from the latest data to preserve other edits.")
            atomic_json(args.data, result)
            written = True
        report["dataWritten"] = written
        report["outputSha256"] = sha256(Path(args.data).read_bytes())
        atomic_json(args.report, report)
        print(json.dumps({k: v for k, v in report.items() if k not in ["records", "matching", "measurementRules"]}, ensure_ascii=False))
        return 0
    except (RepairError, OSError, ValueError, KeyError, InvalidOperation) as error:
        failure = {"schemaVersion": 1, "operation": "recover_reviewed_arbor_stock_2026_04_15", "status": "aborted", "dryRun": args.dry_run, "dataWritten": written, "reason": str(error)}
        if Path(args.report).resolve() not in {Path(args.data).resolve(), Path(args.source).resolve()}:
            atomic_json(args.report, failure)
        print(json.dumps(failure, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
