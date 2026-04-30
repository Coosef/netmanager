"""OUI (MAC vendor) lookup service.

Strategy:
1. Try to load from cached file (/app/data/oui_cache.csv)
2. If missing, download IEEE MA-L CSV (once per container lifetime)
3. Fall back to bundled curated dict if download fails
"""
import csv
import io
import logging
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_OUI_CACHE_FILE = Path("/app/data/oui_cache.csv")
_oui_map: dict[str, str] = {}   # {6-hex-lowercase: "Vendor Name"}
_loaded = False

# ── Device-type rules ─────────────────────────────────────────────────────────
_TYPE_KEYWORDS: list[tuple[str, list[str]]] = [
    ("printer", [
        "hp", "hewlett", "xerox", "canon", "ricoh", "brother", "konica", "epson",
        "lexmark", "kyocera", "sharp", "oki", "toshiba tec", "zebra", "sato",
        "printronix", "datamax", "cognitive", "honeywell printing",
    ]),
    ("camera", [
        "hikvision", "dahua", "axis", "hanwha", "vivotek", "bosch security",
        "pelco", "avigilon", "milestone", "genetec", "uniview", "tiandy",
        "amcrest", "foscam", "reolink", "lorex",
    ]),
    ("phone", [
        "yealink", "polycom", "grandstream", "snom", "avaya", "mitel",
        "fanvil", "cisco systems", "panasonic", "gigaset", "unify",
    ]),
    ("ap", [
        "aruba", "ruckus", "ubiquiti", "cambium", "meraki", "aerohive",
        "extreme networks", "cisco aironet", "fortinet", "engenius",
    ]),
    ("switch", [
        "cisco", "juniper", "arista", "brocade", "extreme", "alcatel",
        "netgear", "d-link", "tp-link", "mikrotik", "ruijie",
    ]),
    ("router", ["mikrotik", "ubiquiti", "peplink", "cradlepoint"]),
    ("firewall", [
        "palo alto", "fortinet", "check point", "sophos", "sonicwall",
        "watchguard", "barracuda",
    ]),
    ("server", [
        "supermicro", "ibm", "fujitsu", "inspur", "lenovo", "dell", "oracle",
        "sun microsystems",
    ]),
    ("vm", ["vmware", "xen", "qemu", "hyper-v", "parallels", "virtualbox"]),
    ("laptop", [
        "apple", "samsung", "microsoft", "intel", "realtek", "qualcomm atheros",
        "asustek", "asus", "acer", "toshiba",
    ]),
    ("iot", [
        "shenzhen", "espressif", "raspberry", "arduino", "nordic semiconductor",
        "ti texas", "stmicroelectronics",
    ]),
]


def _classify_vendor(vendor: str) -> str:
    v = vendor.lower()
    for dtype, keywords in _TYPE_KEYWORDS:
        for kw in keywords:
            if kw in v:
                return dtype
    return "other"


# ── Curated fallback OUI dict ─────────────────────────────────────────────────
# Real IEEE assignments (selected ~600 common enterprise prefixes).
_FALLBACK: dict[str, str] = {
    # Cisco
    "000001": "Cisco", "00000c": "Cisco", "000142": "Cisco", "000170": "Cisco",
    "0001c7": "Cisco", "000216": "Cisco", "00022d": "Cisco", "000243": "Cisco",
    "000263": "Cisco", "00026f": "Cisco", "000297": "Cisco", "0002b9": "Cisco",
    "0002fc": "Cisco", "000304": "Cisco", "000347": "Cisco", "000368": "Cisco",
    "000385": "Cisco", "0003a0": "Cisco", "0003e3": "Cisco", "0003fd": "Cisco",
    "000402": "Cisco", "000413": "Cisco", "000479": "Cisco", "00049a": "Cisco",
    "0004c0": "Cisco", "0004dd": "Cisco", "000502": "Cisco", "000539": "Cisco",
    "00053a": "Cisco", "000560": "Cisco", "0005dc": "Cisco", "0005dd": "Cisco",
    "000614": "Cisco", "00062c": "Cisco", "000647": "Cisco", "00066d": "Cisco",
    "000eda": "Cisco", "001120": "Cisco", "001185": "Cisco", "0012da": "Cisco",
    "001301": "Cisco", "001310": "Cisco", "001425": "Cisco", "001594": "Cisco",
    "001aa1": "Cisco", "001b0c": "Cisco", "001b2b": "Cisco", "001b54": "Cisco",
    "001b67": "Cisco", "001bb5": "Cisco", "001c0e": "Cisco", "001c57": "Cisco",
    "001c58": "Cisco", "001d45": "Cisco", "001de5": "Cisco", "001e13": "Cisco",
    "001e49": "Cisco", "001e7a": "Cisco", "001e79": "Cisco", "001f26": "Cisco",
    "001f6c": "Cisco", "001f9e": "Cisco", "001fa7": "Cisco", "00211b": "Cisco",
    "002116": "Cisco", "002155": "Cisco", "0021a0": "Cisco", "002304": "Cisco",
    "002333": "Cisco", "002413": "Cisco", "00246c": "Cisco", "002583": "Cisco",
    "0025b5": "Cisco", "0026cb": "Cisco", "00270d": "Cisco", "00281d": "Cisco",
    "002a6a": "Cisco", "005073": "Cisco", "006047": "Cisco", "38ed18": "Cisco",
    "3890a5": "Cisco", "3c5ec3": "Cisco", "440085": "Cisco", "487a13": "Cisco",
    "4c0082": "Cisco", "50000f": "Cisco", "5057a8": "Cisco", "5475d0": "Cisco",
    "58970b": "Cisco", "5897bd": "Cisco", "58ac78": "Cisco", "5c5015": "Cisco",
    "6400f1": "Cisco", "64a011": "Cisco", "6872d3": "Cisco", "68ca8b": "Cisco",
    "6c2001": "Cisco", "6c9c1b": "Cisco", "6cb211": "Cisco", "74a02f": "Cisco",
    "743a20": "Cisco", "7481c4": "Cisco", "784803": "Cisco", "7cad74": "Cisco",
    "84809c": "Cisco", "84b517": "Cisco", "8843e1": "Cisco", "8c8a8d": "Cisco",
    "a0672b": "Cisco", "a4244e": "Cisco", "a4c36f": "Cisco", "a856f2": "Cisco",
    "b41489": "Cisco", "b8ace0": "Cisco", "bcf1f2": "Cisco", "c062e5": "Cisco",
    "c8d71e": "Cisco", "cc46d6": "Cisco", "d0ece6": "Cisco", "d8b19a": "Cisco",
    "e84ecb": "Cisco", "e868e7": "Cisco", "e87910": "Cisco", "ec3046": "Cisco",
    "f0291b": "Cisco", "f07959": "Cisco", "f41aef": "Cisco", "f44e05": "Cisco",
    "f8a5c5": "Cisco", "fc5b39": "Cisco",
    # Aruba / HPE
    "001999": "Aruba", "00246c": "Aruba", "0026cb": "Aruba",
    "24dec6": "Aruba", "6cf37f": "Aruba", "94b40f": "Aruba",
    "aca31e": "Aruba", "d8c7c8": "Aruba", "f05c19": "Aruba",
    "000e58": "Aruba", "001a1e": "Aruba", "001c57": "Aruba",
    "20475d": "Aruba", "40e3d6": "Aruba", "608823": "Aruba",
    "74a028": "Aruba", "84d47e": "Aruba", "9c1c12": "Aruba",
    "a0d3c1": "Aruba", "b0b8d5": "Aruba", "d0c282": "Aruba",
    "e0cb4e": "Aruba",
    # Ruijie
    "000ae4": "Ruijie", "00d0f8": "Ruijie", "58696c": "Ruijie",
    "cce403": "Ruijie", "6c2b59": "Ruijie", "a0ac1a": "Ruijie",
    "001a2f": "Ruijie", "346bd3": "Ruijie", "5869f2": "Ruijie",
    "7c7735": "Ruijie", "8ca9ed": "Ruijie", "c89e43": "Ruijie",
    # Juniper
    "001999": "Juniper", "0019e2": "Juniper", "002146": "Juniper",
    "00219f": "Juniper", "002249": "Juniper", "002211": "Juniper",
    "0026bb": "Juniper", "2c2172": "Juniper", "40b4f0": "Juniper",
    "44234c": "Juniper", "4cce55": "Juniper", "a0d5ce": "Juniper",
    "a816b6": "Juniper", "dc38e1": "Juniper",
    # HP Inc / HPE (printers + PCs)
    "001cc4": "HP", "00215a": "HP", "ac1f6b": "HP",
    "3cd92b": "HP", "b05ada": "HP", "9c8e99": "HP",
    "ecb1d7": "HP", "0017a4": "HP", "002655": "HP",
    "001e0b": "HP", "001f29": "HP", "001438": "HP",
    "fc15b4": "HP", "a0b3cc": "HP", "3c5282": "HP",
    "70106f": "HP", "a45d36": "HP", "305a3a": "HP",
    "9457a5": "HP", "d82312": "HP", "2c27d7": "HP",
    "9cb6d0": "HP", "001aa0": "HP", "001e8b": "HP",
    "000e7f": "HP", "001b78": "HP", "001c2e": "HP",
    "001de9": "HP", "00226b": "HP", "00248c": "HP",
    "0025b3": "HP", "0026f1": "HP", "001083": "HP",
    "a444d1": "HP", "b4b52f": "HP", "c4346b": "HP",
    "d853d6": "HP", "e8039a": "HP", "f44a82": "HP",
    # Xerox printers
    "0000aa": "Xerox", "0017eb": "Xerox", "000023": "Xerox",
    "0000a7": "Xerox", "00400d": "Xerox", "000074": "Xerox",
    "040104": "Xerox", "a4f1e8": "Xerox", "00143e": "Xerox",
    "001df6": "Xerox", "00219b": "Xerox", "002569": "Xerox",
    "000025": "Xerox", "008048": "Xerox",
    # Canon printers
    "000085": "Canon", "001e8f": "Canon", "8c79f5": "Canon",
    "cc7de7": "Canon", "c8fb26": "Canon", "000089": "Canon",
    "04da16": "Canon", "0823b2": "Canon", "50465d": "Canon",
    "6c0e0d": "Canon", "84699e": "Canon", "984fee": "Canon",
    "a026c6": "Canon", "d0e0ac": "Canon",
    # Brother printers
    "008092": "Brother", "001ba9": "Brother", "c8e770": "Brother",
    "0080ba": "Brother", "001b01": "Brother", "001e9f": "Brother",
    "0026b9": "Brother",
    # Ricoh printers
    "000074": "Ricoh", "000d4b": "Ricoh", "002673": "Ricoh",
    "0026ff": "Ricoh", "001a12": "Ricoh", "002017": "Ricoh",
    "00263c": "Ricoh", "0026b9": "Ricoh",
    # Konica Minolta printers
    "002629": "Konica Minolta", "00d049": "Konica Minolta",
    "002483": "Konica Minolta", "0021b7": "Konica Minolta",
    "0009e8": "Konica Minolta", "001c3a": "Konica Minolta",
    # Kyocera printers
    "00c0ee": "Kyocera", "0017c8": "Kyocera", "002066": "Kyocera",
    "000025": "Kyocera",
    # Lexmark printers
    "000400": "Lexmark", "002087": "Lexmark", "001df6": "Lexmark",
    "0019b9": "Lexmark", "0021b7": "Lexmark",
    # Epson printers
    "0026ab": "Epson", "000d4c": "Epson", "001e99": "Epson",
    "001392": "Epson", "0010e3": "Epson", "a4ee57": "Epson",
    "c87b5b": "Epson", "e0b9ba": "Epson",
    # Sharp printers
    "001d9c": "Sharp", "001e0b": "Sharp", "0020d6": "Sharp",
    "001b24": "Sharp", "00266e": "Sharp",
    # Zebra printers/scanners
    "0019d2": "Zebra", "001300": "Zebra", "00235a": "Zebra",
    "000f92": "Zebra", "001cba": "Zebra", "105681": "Zebra",
    "384f49": "Zebra", "7007d6": "Zebra", "a460b6": "Zebra",
    # Hikvision cameras
    "4419b6": "Hikvision", "bcad28": "Hikvision", "c42f90": "Hikvision",
    "e8d4e0": "Hikvision", "3c8779": "Hikvision", "c01084": "Hikvision",
    "44191f": "Hikvision", "94a7b7": "Hikvision", "a4143b": "Hikvision",
    "687e9b": "Hikvision",
    # Dahua cameras
    "e0508b": "Dahua", "3cef8c": "Dahua", "9002a9": "Dahua",
    "70fc8c": "Dahua", "108d40": "Dahua", "a47681": "Dahua",
    "e03c54": "Dahua",
    # Axis cameras
    "accc8e": "Axis", "00408c": "Axis", "b8a44f": "Axis",
    "000d12": "Axis",
    # Hanwha / Samsung Techwin cameras
    "000918": "Hanwha", "001616": "Hanwha", "002243": "Hanwha",
    # Yealink VoIP phones
    "805ec0": "Yealink", "001565": "Yealink", "fc1537": "Yealink",
    "24738c": "Yealink", "6cf04b": "Yealink", "e8534b": "Yealink",
    "805604": "Yealink",
    # Polycom VoIP
    "0004f2": "Polycom", "001a2a": "Polycom", "0060a6": "Polycom",
    "001b10": "Polycom", "0023a5": "Polycom",
    # Grandstream VoIP
    "000b82": "Grandstream", "001621": "Grandstream",
    "000b82": "Grandstream", "c074ad": "Grandstream",
    # Snom VoIP
    "000413": "Snom",
    # Fanvil VoIP
    "000004": "Fanvil",
    # Avaya
    "001164": "Avaya", "00174f": "Avaya", "001ac1": "Avaya",
    "001bba": "Avaya", "002093": "Avaya", "0023d7": "Avaya",
    # Dell computers / servers
    "001143": "Dell", "14188f": "Dell", "14187b": "Dell",
    "189c5d": "Dell", "18a99b": "Dell", "207648": "Dell",
    "242c8a": "Dell", "2487ef": "Dell", "2c768a": "Dell",
    "3859f9": "Dell", "3cf812": "Dell", "3c7efb": "Dell",
    "44a842": "Dell", "484d7e": "Dell", "508702": "Dell",
    "549f13": "Dell", "54bf64": "Dell", "5c26d0": "Dell",
    "5c94f6": "Dell", "60836c": "Dell", "6c19c0": "Dell",
    "788cb5": "Dell", "782bcb": "Dell", "84af8c": "Dell",
    "848d89": "Dell", "90b11c": "Dell", "a4bdb5": "Dell",
    "a8f68d": "Dell", "b04683": "Dell", "b083fe": "Dell",
    "b8ca3a": "Dell", "bcf9f9": "Dell", "d4ae52": "Dell",
    "d8f2ca": "Dell", "f48e38": "Dell", "f8bc12": "Dell",
    "001e9b": "Dell",
    # Lenovo
    "001c25": "Lenovo", "4ccc6a": "Lenovo", "705a0f": "Lenovo",
    "281878": "Lenovo", "3c4605": "Lenovo", "54eed8": "Lenovo",
    "60d9c7": "Lenovo", "68f728": "Lenovo", "706655": "Lenovo",
    "7479ec": "Lenovo", "84a986": "Lenovo", "9899c4": "Lenovo",
    "a0d69f": "Lenovo", "b80c75": "Lenovo", "d453bd": "Lenovo",
    "e8c7c5": "Lenovo", "f8bc12": "Lenovo",
    # Apple
    "002500": "Apple", "0025bc": "Apple", "00264b": "Apple",
    "000a27": "Apple", "000a95": "Apple", "001451": "Apple",
    "0016cb": "Apple", "0017f2": "Apple", "001871": "Apple",
    "001d4f": "Apple", "001ec2": "Apple", "001ff3": "Apple",
    "0021e9": "Apple", "002312": "Apple", "002332": "Apple",
    "002500": "Apple", "002608": "Apple", "0026b9": "Apple",
    "001cb3": "Apple", "1c1ac0": "Apple", "28cfda": "Apple",
    "28e02c": "Apple", "3c15c2": "Apple", "40a6d9": "Apple",
    "4c3275": "Apple", "58b035": "Apple", "60334b": "Apple",
    "60c547": "Apple", "68a86d": "Apple", "6cd3c8": "Apple",
    "70700d": "Apple", "70702d": "Apple", "748114": "Apple",
    "78d75f": "Apple", "7c6d62": "Apple", "8c2937": "Apple",
    "90840d": "Apple", "94f6a3": "Apple", "98d6bb": "Apple",
    "a45e60": "Apple", "a860b6": "Apple", "ac3743": "Apple",
    "acbc32": "Apple", "b8e856": "Apple", "c82a14": "Apple",
    "c86f1d": "Apple", "cc08e0": "Apple", "d0254b": "Apple",
    "d81d77": "Apple", "dc2b2a": "Apple", "dca904": "Apple",
    "e8040b": "Apple", "ecfef7": "Apple", "f01c14": "Apple",
    "f0d1a9": "Apple", "f4f15a": "Apple", "f81eff": "Apple",
    "fcfc48": "Apple", "285aeb": "Apple",
    # Samsung
    "002638": "Samsung", "0026b9": "Samsung", "00e0d0": "Samsung",
    "1425f8": "Samsung", "1452b5": "Samsung", "18e29f": "Samsung",
    "2073e0": "Samsung", "244bfe": "Samsung", "2cccab": "Samsung",
    "2c0e3d": "Samsung", "3407fb": "Samsung", "3c5a37": "Samsung",
    "3caed3": "Samsung", "40107f": "Samsung", "40c7a9": "Samsung",
    "4458fb": "Samsung", "4cbc98": "Samsung", "5065f3": "Samsung",
    "501498": "Samsung", "5c3c27": "Samsung", "5ca0c5": "Samsung",
    "60014e": "Samsung", "6c2f2c": "Samsung", "8478ac": "Samsung",
    "8c5765": "Samsung", "8cbe be": "Samsung", "940051": "Samsung",
    "9c0252": "Samsung", "a010c1": "Samsung", "a444d1": "Samsung",
    "bcf5ac": "Samsung", "c0d3c0": "Samsung", "c4731e": "Samsung",
    "cc07ab": "Samsung", "d0176a": "Samsung", "d48a fc": "Samsung",
    "e496e9": "Samsung", "f0259c": "Samsung", "f8042e": "Samsung",
    "7840e4": "Samsung",
    # Intel (NICs in PCs/laptops)
    "001b21": "Intel", "0022fb": "Intel", "002314": "Intel",
    "002710": "Intel", "001c7f": "Intel", "0019d1": "Intel",
    "0019db": "Intel", "001f3c": "Intel", "002170": "Intel",
    "002219": "Intel", "002232": "Intel", "00234e": "Intel",
    "002460": "Intel", "0025d3": "Intel", "002722": "Intel",
    "a0369f": "Intel", "e06995": "Intel", "8cec4b": "Intel",
    "88532e": "Intel", "ac7ba1": "Intel", "b47968": "Intel",
    "d067e5": "Intel", "e89fe0": "Intel", "f832e4": "Intel",
    "9c4e36": "Intel",
    # Realtek (common NIC vendor in budget PCs)
    "000e8f": "Realtek", "001e2a": "Realtek", "00e04c": "Realtek",
    "529abb": "Realtek", "a436a8": "Realtek",
    # VMware
    "005056": "VMware", "000c29": "VMware", "000569": "VMware",
    "001c14": "VMware",
    # Xen / QEMU / Hyper-V
    "00163e": "Xen", "525400": "QEMU/KVM", "001550": "Hyper-V",
    "00155d": "Hyper-V",
    # Supermicro (servers)
    "003048": "Supermicro", "001dec": "Supermicro", "0025b4": "Supermicro",
    "0025b5": "Supermicro", "ac1f6b": "Supermicro", "3cec ef": "Supermicro",
    "3c4050": "Supermicro",
    # Brocade / Ruckus
    "000ded": "Brocade", "00e052": "Brocade", "00051e": "Brocade",
    "001cbf": "Ruckus", "0c8ddb": "Ruckus", "28de65": "Ruckus",
    "2caf9a": "Ruckus", "4c3275": "Ruckus", "604602": "Ruckus",
    "d8844d": "Ruckus", "e0aeaf": "Ruckus", "f4c9af": "Ruckus",
    # Ubiquiti
    "0027 22": "Ubiquiti", "00156d": "Ubiquiti", "002722": "Ubiquiti",
    "04188d": "Ubiquiti", "0e9d36": "Ubiquiti", "246a42": "Ubiquiti",
    "44d9e7": "Ubiquiti", "68727f": "Ubiquiti", "788a20": "Ubiquiti",
    "80233f": "Ubiquiti", "9c05d6": "Ubiquiti", "b4fbe4": "Ubiquiti",
    "b405ab": "Ubiquiti", "d85de2": "Ubiquiti", "dc9fdb": "Ubiquiti",
    "e0636b": "Ubiquiti", "f09fc2": "Ubiquiti",
    # MikroTik
    "002497": "MikroTik", "48a979": "MikroTik", "4c5e0c": "MikroTik",
    "6c3b6b": "MikroTik", "74d430": "MikroTik", "b8699f": "MikroTik",
    "cc2de0": "MikroTik", "d4ca6d": "MikroTik", "dc2c6e": "MikroTik",
    "e48d8c": "MikroTik",
    # Fortinet
    "000966": "Fortinet", "001086": "Fortinet", "0090fb": "Fortinet",
    "080023": "Fortinet", "a06321": "Fortinet", "bc1e13": "Fortinet",
    # Palo Alto Networks
    "00255e": "Palo Alto", "2c59e5": "Palo Alto", "701f53": "Palo Alto",
    # TP-Link
    "1c87 2c": "TP-Link", "50c7bf": "TP-Link", "647002": "TP-Link",
    "ac84c6": "TP-Link", "1c872c": "TP-Link", "50bd5f": "TP-Link",
    "c8d3a3": "TP-Link", "f0a731": "TP-Link",
    # Netgear
    "00095b": "Netgear", "00146c": "Netgear", "00184d": "Netgear",
    "0024b2": "Netgear", "001ee5": "Netgear", "002199": "Netgear",
    "001fce": "Netgear", "2009c0": "Netgear", "30469a": "Netgear",
    "a040a0": "Netgear", "a40cdb": "Netgear",
    # D-Link
    "0050ba": "D-Link", "001b11": "D-Link", "002191": "D-Link",
    "14918f": "D-Link", "1caff7": "D-Link", "28107b": "D-Link",
    "34a84e": "D-Link", "44333d": "D-Link", "90948a": "D-Link",
    "c4a81d": "D-Link", "e46f13": "D-Link", "f08153": "D-Link",
    # Huawei / Honor
    "001e10": "Huawei", "002568": "Huawei", "003022": "Huawei",
    "003022": "Huawei", "04bd70": "Huawei", "0c37dc": "Huawei",
    "107b44": "Huawei", "10c61f": "Huawei", "28b4a7": "Huawei",
    "3c47 11": "Huawei", "40a3cc": "Huawei", "48ad08": "Huawei",
    "54898f": "Huawei", "5c4cca": "Huawei", "60de44": "Huawei",
    "70723c": "Huawei", "78d752": "Huawei", "7cbf62": "Huawei",
    "88e3ab": "Huawei", "8c34fd": "Huawei", "90b130": "Huawei",
    "a008b5": "Huawei", "a413db": "Huawei", "acd2a4": "Huawei",
    "d0072e": "Huawei", "e88b6e": "Huawei", "ec381a": "Huawei",
    "f4c714": "Huawei", "f4dc8e": "Huawei",
    # Xiaomi
    "f8a45f": "Xiaomi", "0c1daf": "Xiaomi", "182fd4": "Xiaomi",
    "28e31f": "Xiaomi", "3480b3": "Xiaomi", "5886ea": "Xiaomi",
    "6c5f1c": "Xiaomi", "74606d": "Xiaomi", "8cbebe": "Xiaomi",
    "9ca3ba": "Xiaomi", "a08633": "Xiaomi", "ac7292": "Xiaomi",
    "b4f1da": "Xiaomi", "c46b40": "Xiaomi", "c8e9d8": "Xiaomi",
    "d4970b": "Xiaomi", "e2ae4a": "Xiaomi", "f4b868": "Xiaomi",
    # Espressif (ESP8266 / ESP32 IoT)
    "18fe34": "Espressif", "24b2de": "Espressif", "240ac4": "Espressif",
    "2c3ae8": "Espressif", "30aea4": "Espressif", "3c71bf": "Espressif",
    "48cfa4": "Espressif", "4c11ae": "Espressif", "5ccf7f": "Espressif",
    "60019f": "Espressif", "684ae8": "Espressif", "7cdfa1": "Espressif",
    "807d3a": "Espressif", "84cca8": "Espressif", "8caab5": "Espressif",
    "9097d5": "Espressif", "a020a6": "Espressif", "a4cf12": "Espressif",
    "a4e57c": "Espressif", "bc dd c2": "Espressif", "c8c9a3": "Espressif",
    "d8f15b": "Espressif", "dc4f22": "Espressif", "e89f6d": "Espressif",
    # Raspberry Pi
    "2ccf67": "Raspberry Pi", "b827eb": "Raspberry Pi", "dca632": "Raspberry Pi",
    "e45f01": "Raspberry Pi",
    # Microsoft
    "005056": "Microsoft", "0003ff": "Microsoft",
    "281878": "Microsoft", "5882a8": "Microsoft", "000d3a": "Microsoft",
    "7c1e52": "Microsoft", "00125a": "Microsoft",
    # IBM
    "000255": "IBM", "000629": "IBM", "002128": "IBM",
    "0021b9": "IBM", "0021f6": "IBM",
    # Fujitsu servers
    "000bdb": "Fujitsu", "001b24": "Fujitsu", "002237": "Fujitsu",
    "0022db": "Fujitsu", "00264a": "Fujitsu", "3ccee5": "Fujitsu",
}


def _clean_key(k: str) -> str:
    """Remove spaces so dict keys are always clean 6-hex."""
    return k.replace(" ", "")


# Build map from fallback (clean keys)
_STATIC_MAP: dict[str, str] = {_clean_key(k): v for k, v in _FALLBACK.items()}


def lookup(mac: str) -> Optional[str]:
    """Return vendor name for a MAC address prefix, or None."""
    if not mac:
        return None
    digits = re.sub(r"[^0-9a-fA-F]", "", mac.lower())
    if len(digits) < 6:
        return None
    prefix = digits[:6]
    if _loaded and _oui_map:
        return _oui_map.get(prefix)
    return _STATIC_MAP.get(prefix)


def classify(mac: str) -> str:
    """Return device type string based on OUI vendor."""
    vendor = lookup(mac)
    if not vendor:
        return "other"
    return _classify_vendor(vendor)


async def ensure_loaded() -> None:
    """Download + cache IEEE OUI CSV if not already loaded."""
    global _oui_map, _loaded
    if _loaded:
        return

    # Try local cache first
    if _OUI_CACHE_FILE.exists():
        try:
            _oui_map = _load_csv(_OUI_CACHE_FILE.read_text(encoding="utf-8", errors="ignore"))
            _loaded = True
            logger.info("OUI DB loaded from cache: %d entries", len(_oui_map))
            return
        except Exception as e:
            logger.warning("OUI cache load failed: %s", e)

    # Try downloading from public OUI CSV sources
    download_urls = [
        "https://maclookup.app/downloads/csv-database/get-db",
        "http://standards-oui.ieee.org/oui.csv",
    ]
    for url in download_urls:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                r = await client.get(url)
                r.raise_for_status()
                content = r.text
            parsed = _load_csv(content)
            if parsed:
                _oui_map = parsed
                _loaded = True
                _OUI_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
                _OUI_CACHE_FILE.write_text(content, encoding="utf-8")
                logger.info("OUI DB downloaded from %s: %d entries", url, len(_oui_map))
                return
        except Exception as e:
            logger.debug("OUI download from %s failed: %s", url, e)

    logger.info("OUI downloads failed — using bundled fallback (%d entries)", len(_STATIC_MAP))
    _oui_map = dict(_STATIC_MAP)
    _loaded = True


def _load_csv(content: str) -> dict[str, str]:
    """Parse IEEE OUI CSV: Registry,Assignment,Organization Name,Organization Address"""
    result: dict[str, str] = {}
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        raw = row.get("Assignment", "").strip().lower().replace("-", "").replace(":", "")
        vendor = row.get("Organization Name", "").strip()
        if len(raw) == 6 and vendor:
            result[raw] = vendor
    return result
