#!/usr/bin/env python3
"""One-time, idempotent correction of archived Serbian supplier prices."""
import json
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP

path=Path("data/kataloske-stavke.json")
data=json.loads(path.read_text(encoding="utf-8"))
rate=Decimal("117.6203")
fixed=0
verified=0
for o in data["offers"]:
    if o.get("nurseryId") not in ("rasadnik-zica","topalovic-unresolved"): continue
    if o.get("price") is None: continue
    if (o["nurseryId"]=="rasadnik-zica" and o.get("sourceCurrency")=="EUR"
        and o.get("currency")=="EUR" and o.get("sourceAmount")==o.get("price")
        and not o.get("priceConversion")):
        original=o["sourceAmount"]
        o["sourceCurrency"]="RSD"
        o["currency"]="EUR"
        o["currencyStatus"]="converted"
        o["price"]=float((Decimal(str(original))/rate).quantize(Decimal(".01"),rounding=ROUND_HALF_UP))
        o["priceConversion"]={"status":"converted","fromCurrency":"RSD",
            "toCurrency":"EUR","originalAmount":original,"rate":float(rate),
            "rateDate":"2026-11-13",
            "sourceUrl":"https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentMiddleRate"}
        fixed+=1
    elif o.get("sourceCurrency")=="RSD" and o.get("priceConversion",{}).get("status")=="converted":
        c=o["priceConversion"]
        expected=float((Decimal(str(o["sourceAmount"]))/Decimal(str(c["rate"]))).quantize(Decimal(".01"),rounding=ROUND_HALF_UP))
        assert abs(expected-o["price"])<.001,(o["id"],expected,o["price"])
        verified+=1
    else:
        raise ValueError(f"Unresolved currency at {o['id']}")
assert fixed in (0,66),(fixed,verified)
assert verified in (31,97),(fixed,verified)
data["updatedAt"]="2026-11-18T08:31:00Z"
path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(f"Corrected {fixed}; checked {verified} existing EUR conversions.")
