"""Local server for the pronunciation coach.

- Serves the web UI from ./static
- GET /api/sentences : practice sentences extracted from a deck (.pptx), transcript (.txt) or folder of them
- GET /api/token     : short-lived Azure Speech token (the subscription key never leaves this PC)

Run:  python server.py [path/to/deck.pptx]
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DEFAULT_PPTX = ROOT / "decks"  # every .pptx / .txt in this folder
PORT = int(os.environ.get("PORT", "8765"))

# Slides whose titles start with these are notes, not lines to read aloud.
SKIP_TITLES = ("Interview Script", "Be ready to explain")

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def load_env():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ---------------------------------------------------------------- deck parsing

def slide_paths(z):
    """Slide part names in presentation order."""
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    rels = ET.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    ids = pres.find("p:sldIdLst", NS)
    return ["ppt/" + target[s.get(f"{{{NS['r']}}}id")].lstrip("/").removeprefix("ppt/") for s in ids]


def paragraph_markup(p):
    """Paragraph text with **bold** markers and \\n for line breaks."""
    out = []
    for child in p:
        tag = child.tag.split("}")[1]
        if tag == "r":
            t = child.findtext("a:t", default="", namespaces=NS)
            rpr = child.find("a:rPr", NS)
            bold = rpr is not None and rpr.get("b") == "1"
            out.append(f"**{t}**" if bold and t.strip() else t)
        elif tag == "br":
            out.append("\n")
    text = "".join(out).replace("\t", " ")
    return re.sub(r"\*\*(\s*)\*\*", r"\1", text)  # merge adjacent bold runs


def split_sentences(markup):
    markup = re.sub(r"^\d+\.\s+", "", markup.strip())  # drop list numbering
    parts = re.split(r'(?:(?<=[.?!])|(?<=[.?!]\*\*))\s+(?=(?:\*\*)?["A-Z])', markup)
    return [s.strip() for s in parts if s.strip()]


JP = re.compile(r"[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]")
HEADING = re.compile(r"^(Q\b.*|Opening\b.*|If they ask\b.*|When they ask\b.*|Closing\b.*)$")


def notes_path(z, slide_path):
    rels_path = slide_path.replace("slides/", "slides/_rels/") + ".rels"
    if rels_path not in z.namelist():
        return None
    for r in ET.fromstring(z.read(rels_path)):
        if r.get("Type", "").endswith("/notesSlide"):
            return "ppt/" + r.get("Target").replace("../", "")
    return None


def notes_groups(z, slide_path, title):
    """English script kept in the speaker notes (1 line = 1 breath), grouped by question.

    Japanese memo lines, 【...】 labels and question/heading lines are not read aloud.
    Returns [] when the notes hold no script, so the slide text is used instead.
    """
    path = notes_path(z, slide_path)
    if not path or path not in z.namelist():
        return []
    root = ET.fromstring(z.read(path))
    paras = []
    for sp in root.iter(f"{{{NS['p']}}}sp"):
        ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
        body = sp.find("p:txBody", NS)
        if ph is None or ph.get("type") != "body" or body is None:
            continue
        for p in body.findall("a:p", NS):
            paras.extend(paragraph_markup(p).split("\n"))
    groups, cur, english = [], None, 0
    for para in paras:
        plain = para.replace("**", "").strip()
        if plain == "---":
            break  # e.g. the thank-you email template that follows the closing
        if not plain or plain.startswith("【") or JP.search(plain) or plain.startswith("(or:"):
            continue
        if HEADING.match(plain) or (plain.endswith(":") and plain.startswith(("Q", "Opening", "If ", "When ", "Closing"))):
            q = re.sub(r"^Q(\s*\([^)]*\))?:\s*", "", plain).rstrip(":").strip()
            cur = {"title": q or title, "lines": []}
            groups.append(cur)
            continue
        if cur is None:
            cur = {"title": title, "lines": []}
            groups.append(cur)
        cur["lines"].append(para.strip())
        english += 1
    words = sum(len(l.replace("**", "").split()) for g in groups for l in g["lines"])
    if english < 3 and words < 15:
        return []
    out = []
    for g in groups:
        if not g["lines"]:
            continue
        joined = " ".join(g["lines"])
        joined = re.sub(r"\*\*(\s*)\*\*", r"\1", joined)
        out.append({"title": g["title"], "sentences": split_sentences(joined)})
    return out


def extract_sentences(pptx, use_notes=True):
    groups, slides = [], []
    with zipfile.ZipFile(pptx) as z:
        for idx, path in enumerate(slide_paths(z), start=1):
            root = ET.fromstring(z.read(path))
            title, sentences = "", []
            for sp in root.iter(f"{{{NS['p']}}}sp"):
                ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
                name = sp.find("p:nvSpPr/p:cNvPr", NS).get("name", "")
                body = sp.find("p:txBody", NS)
                if body is None:
                    continue
                paras = [paragraph_markup(p) for p in body.findall("a:p", NS)]
                if ph is not None and ph.get("type") == "title":
                    title = " ".join(x.replace("**", "") for x in paras).strip()
                    continue
                if ph is not None or name == "Badge label":
                    continue
                for para in paras:
                    plain = para.replace("**", "").strip()
                    # skip labels that are entirely bold ("Expected salary")
                    if not plain or (para.startswith("**") and para.endswith("**") and para.count("**") == 2):
                        continue
                    sentences.extend(split_sentences(para))
            if title and title.startswith(SKIP_TITLES):
                continue
            from_notes = notes_groups(z, path, title) if use_notes else []
            for part in from_notes:  # slides that are pictures only: name them by their first line
                if not part["title"] and part["sentences"]:
                    first = part["sentences"][0].replace("**", "")
                    part["title"] = first if len(first) <= 60 else first[:57].rsplit(" ", 1)[0] + "..."
            from_slide = [{"title": title, "sentences": sentences}] if title and sentences else []
            slides.append((idx, from_notes, from_slide))
    # A deck with the script in the notes uses only the notes; the slide text is diagram labels.
    notes_deck = any(from_notes for _, from_notes, _ in slides)
    # Prefix ids with the deck name so best scores from different decks don't mix.
    prefix = f"{Path(pptx).stem}:" if notes_deck else ""
    for idx, from_notes, from_slide in slides:
        n = 0
        for part in (from_notes if notes_deck else from_slide):
            items = []
            for s in part["sentences"]:
                items.append({"id": f"{prefix}s{idx}-{n}", "markup": s, "text": re.sub(r"\s+", " ", s.replace("**", "")).strip()})
                n += 1
            groups.append({"slide": idx, "title": part["title"], "sentences": items})
    return groups


def extract_generic(pptx):
    """Fallback for ordinary decks: every English paragraph on the slide and in its notes.

    Used when the script layout finds little, e.g. decks built from layout placeholders.
    """
    groups = []
    with zipfile.ZipFile(pptx) as z:
        for idx, path in enumerate(slide_paths(z), start=1):
            root = ET.fromstring(z.read(path))
            title, paras = "", []
            for sp in root.iter(f"{{{NS['p']}}}sp"):
                ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
                body = sp.find("p:txBody", NS)
                if body is None or (ph is not None and ph.get("type") in ("sldNum", "dt", "ftr")):
                    continue
                texts = [paragraph_markup(p) for p in body.findall("a:p", NS)]
                if ph is not None and ph.get("type") in ("title", "ctrTitle"):
                    title = " ".join(t.replace("**", "") for t in texts).strip()
                    continue
                paras.extend(texts)
            npath = notes_path(z, path)
            if npath and npath in z.namelist():
                for sp in ET.fromstring(z.read(npath)).iter(f"{{{NS['p']}}}sp"):
                    ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
                    body = sp.find("p:txBody", NS)
                    if ph is not None and ph.get("type") == "body" and body is not None:
                        paras.extend(paragraph_markup(p) for p in body.findall("a:p", NS))
            sentences = []
            for para in paras:
                for line in para.split("\n"):
                    plain = line.replace("**", "").strip()
                    if JP.search(plain) or len(plain.split()) < 4 or plain.startswith("【"):
                        continue
                    sentences.extend(t for t in split_sentences(line) if len(t.replace("**", "").split()) >= 3)
            if sentences:
                if not title:
                    first = sentences[0].replace("**", "")
                    title = first if len(first) <= 60 else first[:57].rsplit(" ", 1)[0] + "..."
                groups.append({"slide": idx, "title": title, "sentences": [
                    {"id": f"{Path(pptx).stem}:g{idx}-{i}", "markup": t, "text": re.sub(r"\s+", " ", t.replace("**", "")).strip()}
                    for i, t in enumerate(sentences)
                ]})
    return groups


def read_text(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")


def chunk_words(words, size=14):
    """Split a long run of words into nearly equal chunks of about `size` words."""
    n = max(1, round(len(words) / size))
    step = len(words) / n
    return [" ".join(words[round(i * step):round((i + 1) * step)]) for i in range(n)]


def extract_text_sentences(path, per_part=10):
    """Practice lines from a plain-text transcript (e.g. Whisper output).

    Transcripts often have no punctuation, so long stretches are cut into ~14-word lines.
    Japanese lines, very short fillers ("Bye.", "Okay.") and repeats are left out.
    """
    lines = [l.strip() for l in read_text(path).splitlines()]
    seen = set()

    def practice_lines(section, longest=20):
        text = " ".join(l for l in section if l and not JP.search(l))
        out = []
        for piece in re.split(r"(?<=[.?!])\s+", re.sub(r"\s+", " ", text).strip()):
            words = piece.split()
            if len(words) < 3:
                continue
            for chunk in (chunk_words(words) if len(words) > longest else [piece]):
                key = re.sub(r"\W+", " ", chunk.lower()).strip()
                if key not in seen:
                    seen.add(key)
                    out.append(chunk)
        return out

    # A script written by hand can mark its sections with "# Title" lines.
    if any(l.startswith("# ") for l in lines):
        sections, cur = [], None
        for l in lines:
            if l.startswith("# "):
                cur = {"title": l[2:].strip(), "lines": []}
                sections.append(cur)
            elif cur is not None:
                cur["lines"].append(l)
        groups = []
        for idx, sec in enumerate(sections, start=1):
            part = practice_lines(sec["lines"], longest=40)  # a written script has real sentences: keep them whole
            if part:
                groups.append({"slide": idx, "title": sec["title"], "sentences": [
                    {"id": f"{Path(path).stem}:t{idx}-{i}", "markup": t, "text": t} for i, t in enumerate(part)
                ]})
        return groups

    out = practice_lines(lines)
    groups = []
    for start in range(0, len(out), per_part):
        part = out[start:start + per_part]
        idx = start // per_part + 1
        first = part[0] if len(part[0]) <= 60 else part[0][:57].rsplit(" ", 1)[0] + "..."
        groups.append({"slide": idx, "title": first, "sentences": [
            {"id": f"{Path(path).stem}:t{idx}-{i}", "markup": s, "text": s} for i, s in enumerate(part)
        ]})
    return groups


def extract_any(path):
    return extract_text_sentences(path) if Path(path).suffix.lower() == ".txt" else extract_sentences(path)


def mostly_english(f):
    """Folders often mix English decks with Japanese study notes and code; keep only English practice material."""
    if f.suffix.lower() == ".txt":
        lines = [l for l in read_text(f).splitlines() if l.strip()]
        code = sum(1 for l in lines if re.search(r"[=(){}\[\]]|^\s*(def|import|for|if|print)\b", l))
        text = " ".join(lines)
    else:
        with zipfile.ZipFile(f) as z:
            parts = [n for n in z.namelist() if re.match(r"ppt/(slides|notesSlides)/[^/]+\.xml$", n)]
            text = " ".join(" ".join(re.findall(r"<a:t>([^<]*)</a:t>", z.read(n).decode("utf-8", "replace"))) for n in parts)
        code, lines = 0, [1]
    jp = len(JP.findall(text))
    en = len(re.findall(r"[A-Za-z]", text))
    return en > 0 and jp <= 0.2 * (jp + en) and code <= 0.3 * len(lines)


def extract_folder(folder):
    """Every .pptx / .txt in a folder, each tagged with its deck name so the page can switch between them."""
    groups, decks = [], []
    root = Path(folder)
    files = [f for f in root.rglob("*") if f.is_file()]  # subfolders too (one per teacher, etc.)
    for f in sorted(files, key=lambda p: str(p.relative_to(root)).lower()):
        if f.suffix.lower() not in (".pptx", ".txt") or f.name.startswith(("~$", ".")):
            continue
        name = f.relative_to(root).with_suffix("").as_posix()
        try:
            if not mostly_english(f):
                continue
        except Exception:  # noqa: BLE001 - unreadable files are reported below
            pass
        try:
            found = extract_any(f)
            if f.suffix.lower() == ".pptx":
                generic = extract_generic(f)
                count = lambda gs: sum(len(g["sentences"]) for g in gs)
                if count(found) < 20 and count(generic) > count(found):  # script decks keep their own layout
                    found = generic
        except Exception as e:  # noqa: BLE001 - one bad file should not hide the others
            print(f"読み込めませんでした: {f.name}: {e}")
            continue
        if not found:
            continue
        decks.append(name)
        for g in found:
            for s in g["sentences"]:
                if ":" not in s["id"]:
                    s["id"] = f"{f.stem}:{s['id']}"  # keep best scores apart between decks
            groups.append({**g, "deck": name})
    return decks, groups


# ---------------------------------------------------------------- Azure token

_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()
_log_lock = threading.Lock()


def get_token():
    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    if not key or not region:
        raise RuntimeError("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION が .env に設定されていません。README.md を見て設定してください。")
    if not key.isascii() or not region.isascii() or " " in key:
        raise RuntimeError(".env のキーかリージョンがまだ書き換えられていません(Azure のキー1をそのまま貼り付けてください)。")
    with _token_lock:
        if _token["value"] and time.time() < _token["expires"]:
            return _token["value"], region
        req = urllib.request.Request(
            f"https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken",
            data=b"", method="POST",
            headers={"Ocp-Apim-Subscription-Key": key, "Content-Length": "0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                value = resp.read().decode()
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Azure からトークンを取得できませんでした (HTTP {e.code})。キーとリージョンを確認してください。") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Azure に接続できませんでした: {e.reason}") from e
        _token.update(value=value, expires=time.time() + 8 * 60)  # tokens live 10 minutes
        return value, region


# ---------------------------------------------------------------- practice log

def upgrade_log(log, fields):
    """Rewrite a log made by an older version so its header has every column (new ones are left empty)."""
    import csv
    if not log.exists():
        return
    with open(log, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
        header = rows[0].keys() if rows else []
    if not rows or list(header) == fields:
        return
    with open(log, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/log":
            self.append_log()
            return
        if path != "/api/note":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            text = self.rfile.read(min(length, 2_000_000)).decode("utf-8")
            notes = ROOT / "notes"
            notes.mkdir(exist_ok=True)
            path = notes / f"苦手な単語ノート_{time.strftime('%Y-%m-%d')}.md"
            path.write_text(text, encoding="utf-8")
            self.send_json(200, {"path": str(path)})
        except Exception as e:  # noqa: BLE001 - show the reason in the page
            self.send_json(500, {"error": str(e)})

    LOG_FIELDS = ["date", "time", "deck", "slide", "title", "sentence", "locale",
                  "total", "accuracy", "fluency", "completeness", "prosody", "low_words", "low_sounds"]

    def append_log(self):
        """Append one recording's scores to notes/練習ログ.csv (UTF-8 with BOM so Excel reads Japanese)."""
        import csv
        try:
            length = int(self.headers.get("Content-Length", "0"))
            row = json.loads(self.rfile.read(min(length, 200_000)).decode("utf-8"))
            row.update(date=time.strftime("%Y-%m-%d"), time=time.strftime("%H:%M:%S"))
            notes = ROOT / "notes"
            notes.mkdir(exist_ok=True)
            log = notes / "練習ログ.csv"
            upgrade_log(log, self.LOG_FIELDS)
            new = not log.exists()
            with _log_lock, open(log, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
                w = csv.DictWriter(f, fieldnames=self.LOG_FIELDS, extrasaction="ignore")
                if new:
                    w.writeheader()
                w.writerow(row)
            self.send_json(200, {"path": str(log)})
        except Exception as e:  # noqa: BLE001 - the page shows the reason
            self.send_json(500, {"error": str(e)})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/sentences":
            try:
                if PPTX.is_dir():
                    decks, groups = extract_folder(PPTX)
                    self.send_json(200, {"deck": PPTX.name, "decks": decks, "groups": groups})
                else:
                    self.send_json(200, {"deck": PPTX.name, "groups": extract_any(PPTX)})
            except Exception as e:  # noqa: BLE001 - report any parse problem to the UI
                self.send_json(500, {"error": f"スライドを読み込めませんでした: {e}"})
        elif path == "/api/token":
            try:
                token, region = get_token()
                self.send_json(200, {"token": token, "region": region})
            except RuntimeError as e:
                self.send_json(503, {"error": str(e)})
        else:
            super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            super().log_message(fmt, *args)


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets a second copy bind a port that is still in use, and the
    # browser then keeps talking to the old copy (its slides). Ask for the port exclusively.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    load_env()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    PPTX = Path(args[0]).resolve() if args else DEFAULT_PPTX
    if not PPTX.exists():
        sys.exit(f"ファイルが見つかりません: {PPTX}")
    server = None
    for port in range(PORT, PORT + 10):
        try:
            server = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            # Another copy is still running there; opening that address would show its slides instead.
            print(f"ポート {port} は、前に起動した発音練習アプリが使っています。別のポートで起動します。")
    if server is None:
        sys.exit("発音練習アプリが10個以上起動しています。黒いウィンドウ(コマンドプロンプト)をすべて閉じてから、もう一度起動してください。")
    PORT = port
    url = f"http://localhost:{PORT}/"
    print(f"Pronunciation coach: {url}  (deck: {PPTX.name})  Ctrl+C で終了")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
