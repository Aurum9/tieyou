"""Build the playtest token index from the cached Scryfall and Chinese snapshots."""
from collections import defaultdict
from hashlib import sha256
import json
import re
import tarfile

from build_catalog import CACHE, OUTPUT, dumps, included, normalize_text, parse_source_row, read_snapshot


TOKEN_LAYOUTS = {"token", "double_faced_token", "emblem"}


def is_token(card):
    return card["layout"] in TOKEN_LAYOUTS or (card["layout"] == "flip" and card["type_line"].startswith("Token "))


def oracle_key(text):
    # Older printings use "this artifact" where the same ability now says "this token".
    text = " ".join(normalize_text(text).split())
    return re.sub(r"\bsacrifice this (?:artifact|creature|token|permanent)\b", "sacrifice this token", text, flags=re.I)


def token_faces(card, side=0):
    faces = card.get("card_faces") or [card]
    # Incubator tokens actually transform. Other linked double-sided printings
    # use their front for the token created (the back can be a different token).
    return faces if card["name"] == "Incubator // Phyrexian" else faces[side:side + 1]


def signature(card, side=0):
    return tuple((face["name"], face["type_line"], oracle_key(face.get("oracle_text")),
                  face.get("power", ""), face.get("toughness", ""), tuple(sorted(face.get("colors") or [])))
                 for face in token_faces(card, side))


def artwork(card, face):
    images = face.get("image_uris") or card.get("image_uris") or {}
    return images.get("normal") or images.get("display")


def printing_rank(card, side=0):
    return (bool(artwork(card, token_faces(card, side)[0])), "paper" in card.get("games", []),
            card.get("lang") == "en", card.get("released_at", ""), card["id"])


def chinese_rows(token_names):
    with tarfile.open(CACHE / "chinese.tar.gz", "r|gz") as archive:
        for member in archive:
            if member.name.rsplit("/", 1)[-1] != "zhs_oracle.json":
                continue
            with archive.extractfile(member) as handle:
                for raw in handle:
                    try:
                        row, _ = parse_source_row(raw.decode("utf-8"))
                    except json.JSONDecodeError:
                        continue
                    if (row.get("name"), row.get("type_line")) in token_names:
                        yield row
            return
    raise ValueError("Chinese snapshot is missing zhs_oracle.json")


def token_index():
    freeze_date = json.loads((OUTPUT / "manifest.json").read_text(encoding="utf-8"))["freezeDate"]
    printings = {}
    paper_cards = set()
    oracle_parts = {}
    printing_parts = defaultdict(dict)
    for source in ("oracle_cards", "default_cards"):
        for card in read_snapshot(CACHE / (source + ".jsonl.gz")):
            if is_token(card):
                printings[card["id"]] = card
                continue
            oracle_id = card.get("oracle_id")
            if not oracle_id:
                continue
            released = included(card, freeze_date)
            if released:
                paper_cards.add(oracle_id)
            parts = [part for part in card.get("all_parts", []) if part["component"] == "token"]
            text = card.get("oracle_text") or "\n".join(face.get("oracle_text") or "" for face in card.get("card_faces", []))
            if parts and source == "oracle_cards":
                oracle_parts[oracle_id] = [(part, text) for part in parts]
            elif parts and released:
                printing_parts[oracle_id].update({part["id"]: (part, text) for part in parts})

    earlier_by_signature = {}
    printings_by_name = defaultdict(dict)
    for card in printings.values():
        if card.get("released_at", "9999") > freeze_date:
            continue
        key = signature(card)
        current = earlier_by_signature.get(key)
        if current is None or printing_rank(card) > printing_rank(current):
            earlier_by_signature[key] = card
        variants = printings_by_name[(card["name"], card["type_line"])]
        if key not in variants or printing_rank(card) > printing_rank(variants[key]):
            variants[key] = card

    def released_token(part):
        card = printings.get(part["id"])
        if card and card.get("released_at", "9999") > freeze_date:
            return earlier_by_signature.get(signature(card))
        if card:
            return card
        alternatives = printings_by_name[(part["name"], part["type_line"])].values()
        return next(iter(alternatives)) if len(alternatives) == 1 else None

    representatives = {}
    by_card = {}
    unresolved = set()
    for card_id in sorted(paper_cards):
        printing_links = printing_parts.get(card_id, {}).values()
        parts = oracle_parts.get(card_id) or printing_links
        ids = []
        for part, text in parts:
            card = released_token(part)
            if not card:
                variants = {}
                for alternate, _ in printing_links:
                    if (alternate["name"], alternate["type_line"]) == (part["name"], part["type_line"]):
                        alternate_card = released_token(alternate)
                        if alternate_card:
                            variants[signature(alternate_card)] = alternate_card
                if len(variants) == 1:
                    card = next(iter(variants.values()))
            if not card:
                unresolved.add((part["id"], part["name"]))
                continue
            sides = [0]
            if card["layout"] == "flip" and card.get("card_faces"):
                sides = [i for i, face in enumerate(card["card_faces"])
                         if re.search(r"\b" + re.escape(face["name"]) + r" Role\b", text, re.I)]
                if not sides:
                    unresolved.add((part["id"], part["name"]))
            for side in sides:
                key = signature(card, side)
                template_id = sha256(dumps(key).encode()).hexdigest()[:20]
                # Share identical token templates across deck cards. Prefer paper art.
                rank = printing_rank(card, side)
                if template_id not in representatives or rank > representatives[template_id][0]:
                    representatives[template_id] = (rank, card, side)
                if template_id not in ids:
                    ids.append(template_id)
        if ids:
            by_card[card_id] = ids

    names = {(face["name"], face["type_line"]) for _, card, side in representatives.values() for face in token_faces(card, side)}
    direct = defaultdict(list)
    by_name = defaultdict(list)
    for row in chinese_rows(names):
        key = (row["name"], row["type_line"])
        direct[(row.get("oracle_id"), *key)].append(row)
        by_name[key].append(row)

    def localized_face(card, face):
        name, type_line = face["name"], face["type_line"]
        exact = direct[(card.get("oracle_id"), name, type_line)]
        same_name = by_name[(name, type_line)]
        result = {"name": name, "typeLine": type_line}
        oracle_text = face.get("oracle_text", "")
        if oracle_text:
            result["oracleText"] = oracle_text
        for field, source in (("zhName", "translated_name"), ("zhTypeLine", "translated_type")):
            value = next((normalize_text(row[source]) for row in exact if row.get(source)), "")
            if not value:
                names = {normalize_text(row[source]) for row in same_name if row.get(source)}
                if len(names) == 1:
                    value = names.pop()
            if value:
                result[field] = value
        if oracle_text:
            translation = next((row for row in [*exact, *same_name]
                                if row.get("translated_text") and oracle_key(row.get("oracle_text")) == oracle_key(oracle_text)), None)
            if translation:
                result["zhText"] = normalize_text(translation["translated_text"])
                if translation.get("text_source"):
                    result["translationSource"] = translation["text_source"]
        image = artwork(card, face)
        if image:
            result["image"] = image
        for field in ("power", "toughness", "colors"):
            if face.get(field):
                result[field] = face[field]
        return result

    templates = {}
    for template_id, (_, card, side) in sorted(representatives.items()):
        faces = [localized_face(card, face) for face in token_faces(card, side)]
        template = {"id": template_id, "printingId": card["id"], **faces[0]}
        if len(faces) > 1:
            template.update(layout="double_faced_token", faces=faces)
        templates[template_id] = template
    print(f"Linked {len(templates)} token templates to {len(by_card)} paper cards; {len(unresolved)} unresolved printing links")
    print(f"Chinese names: {sum('zhName' in token for token in templates.values())}/{len(templates)}")
    return {"version": 1, "byCard": by_card, "tokens": templates}


if __name__ == "__main__":
    (OUTPUT / "playtest-tokens.json").write_text(dumps(token_index()) + "\n", encoding="utf-8")
