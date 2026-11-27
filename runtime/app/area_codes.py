"""Caller time zone from the NANP area code (static table, no network, no lookup cost).

Used only for the texting window (SA §8 item 5): a message that is not a direct reply must fall inside
the window in BOTH the business's time zone and the caller's likely time zone. A number we cannot place
(unknown area code, non-NANP number) returns None and the caller falls back to the business time zone.

Area codes that span two zones use the zone where most of their numbers are (good enough for a
"likely" zone; the window is checked in the business zone as well). Mobile numbers can move with
their owner, which is why this is a likely zone, not a fact.
"""
from __future__ import annotations

import re

_ZONES = {
    "America/New_York": (
        # CT DE DC
        "203 475 860 959 302 202 771 "
        # FL (peninsula + Tallahassee)
        "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954 "
        # GA ME MD MA NH NJ
        "229 404 470 478 678 706 762 770 912 943 207 227 240 301 410 443 667 339 351 413 508 617 774 781 857 978 "
        "603 201 551 609 640 732 848 856 862 908 973 "
        # NY NC OH
        "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934 "
        "252 336 472 704 743 828 910 919 980 984 216 220 234 283 326 330 380 419 436 440 513 567 614 740 937 "
        # PA RI SC VT VA WV
        "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803 821 839 843 854 864 802 "
        "276 434 540 571 686 703 757 804 826 948 304 681 "
        # KY (east) TN (east)
        "502 606 859 423 865"),
    "America/Detroit": "231 248 269 313 517 586 616 679 734 810 906 947 989",
    "America/Indiana/Indianapolis": "260 317 463 574 765 812 930",
    "America/Chicago": (
        # AL AR IL IA IN(NW) KS KY(west) LA MN MS MO
        "205 251 256 334 483 659 938 327 479 501 870 217 224 309 312 331 447 464 618 630 708 730 773 779 815 "
        "847 861 872 319 515 563 641 712 219 316 620 785 913 270 364 225 318 337 504 985 218 320 507 612 651 763 "
        "924 952 228 601 662 769 314 417 557 573 636 660 816 975 "
        # NE ND OK SD TN(middle/west)
        "308 402 531 701 405 539 572 580 918 605 615 629 731 901 931 "
        # TX (except El Paso) WI
        "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 "
        "972 979 262 274 353 414 534 608 715 920"),
    "America/Denver": "303 719 720 970 983 406 505 575 385 435 801 307 915",
    "America/Boise": "208 986",
    "America/Phoenix": "480 520 602 623 928",
    "America/Los_Angeles": (
        "209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 "
        "747 760 805 818 820 831 840 858 909 916 925 949 951 702 725 775 458 503 541 971 206 253 360 425 509 564"),
    "America/Anchorage": "907",
    "Pacific/Honolulu": "808",
    "America/Puerto_Rico": "787 939 340",
    "America/Toronto": "416 647 437 905 289 365 742 613 343 519 226 548 705 249 807 514 438 450 579 819 873 418 581 367",
    "America/Winnipeg": "204 431",
    "America/Regina": "306 639",
    "America/Edmonton": "403 587 825 780 368",
    "America/Vancouver": "604 778 236 250 672",
    "America/Halifax": "902 782",
    "America/Moncton": "506",
    "America/St_Johns": "709",
}

AREA_TZ: dict[str, str] = {code: tz for tz, codes in _ZONES.items() for code in codes.split()}

_NANP = re.compile(r"^\+1([2-9]\d{2})[2-9]\d{6}$")


def timezone_for(number: str | None) -> str | None:
    """IANA zone for a +1 E.164 number's area code, or None (unknown / not NANP)."""
    m = _NANP.match((number or "").strip())
    return AREA_TZ.get(m.group(1)) if m else None


# US state (two-letter code, Twilio's `InRegion` for AvailablePhoneNumbers/US) per area code. Used by number purchase
# (app.provisioning): when the business's own area code is sold out and Twilio has no geodata for a near-number search,
# a number in the same state is the next best thing. Same codes as _ZONES (US only: no Canada, no territories).
_STATES = {
    "AL": "205 251 256 334 483 659 938", "AK": "907", "AZ": "480 520 602 623 928", "AR": "327 479 501 870",
    "CA": "209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 "
          "747 760 805 818 820 831 840 858 909 916 925 949 951",
    "CO": "303 719 720 970 983", "CT": "203 475 860 959", "DE": "302", "DC": "202 771",
    "FL": "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954",
    "GA": "229 404 470 478 678 706 762 770 912 943", "HI": "808", "ID": "208 986",
    "IL": "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872", "IN": "219 260 317 463 574 765 812 930",
    "IA": "319 515 563 641 712", "KS": "316 620 785 913", "KY": "270 364 502 606 859", "LA": "225 318 337 504 985",
    "ME": "207", "MD": "227 240 301 410 443 667", "MA": "339 351 413 508 617 774 781 857 978",
    "MI": "231 248 269 313 517 586 616 679 734 810 906 947 989", "MN": "218 320 507 612 651 763 924 952",
    "MS": "228 601 662 769", "MO": "314 417 557 573 636 660 816 975", "MT": "406", "NE": "308 402 531",
    "NV": "702 725 775", "NH": "603", "NJ": "201 551 609 640 732 848 856 862 908 973", "NM": "505 575",
    "NY": "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
    "NC": "252 336 472 704 743 828 910 919 980 984", "ND": "701",
    "OH": "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937", "OK": "405 539 572 580 918",
    "OR": "458 503 541 971", "PA": "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878", "RI": "401",
    "SC": "803 821 839 843 854 864", "SD": "605", "TN": "423 615 629 731 865 901 931",
    "TX": "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
    "UT": "385 435 801", "VT": "802", "VA": "276 434 540 571 686 703 757 804 826 948", "WA": "206 253 360 425 509 564",
    "WV": "304 681", "WI": "262 274 353 414 534 608 715 920", "WY": "307",
}

AREA_STATE: dict[str, str] = {code: st for st, codes in _STATES.items() for code in codes.split()}


def state_for_area(area: str | None) -> str | None:
    """Two-letter US state of a 3-digit area code, or None (unknown, Canada, territories)."""
    return AREA_STATE.get((area or "").strip())
