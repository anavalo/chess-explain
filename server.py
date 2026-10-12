# /// script
# requires-python = ">=3.10"
# dependencies = ["chess", "anthropic"]
# ///
"""Local server for the lichess side panel extension.

POST /explain {"fen", "move", "best", "user"} -> {"text", "best", "compared"}
  move: the move to compare against (SAN), best: lichess's top move (UCI, optional), user: lichess username.
  Header X-Anthropic-Key: the Anthropic API key set in the extension (falls back to ANTHROPIC_API_KEY).

Refuses unless the request comes from a Chrome extension and lichess says `user` is not playing a game.
usage: uv run server.py [--port 8765]
"""

import argparse
import importlib
import json
import re
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import anthropic
import chess
import chess.engine

import explain as ex

NODES = 2_000_000
EQUAL_GAP = 0.3  # pawns; below this both moves are called equal and the LLM is skipped
ENGINE = None  # one latest Stockfish kept alive; requests are served one at a time


class Refused(Exception):
    pass


def check_not_playing(user):
    """Fair play: fail closed unless lichess confirms `user` is not in a game."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,30}", user or ""):
        raise Refused("Log in to lichess so I can check you are not playing a game.")
    url = "https://lichess.org/api/users/status?ids=" + urllib.parse.quote(user)
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            status = json.load(r)
    except Exception as e:
        raise Refused(f"Could not verify you are not in a game ({e}).")
    if not status:
        raise Refused(f"Unknown lichess user {user}.")
    if any(s.get("playing") for s in status):
        raise Refused("You are playing a game on lichess. No engine help during games.")


def handle(req, api_key=None):
    importlib.reload(ex)  # pick up prompt and label edits without restarting (the engine stays up)
    check_not_playing(req.get("user"))
    board = chess.Board(req["fen"])
    if not board.is_valid():
        raise ValueError("invalid position")
    try:
        move = ex.parse_move(board, req["move"])
    except ValueError:
        raise ValueError(f"{req['move']} is not a legal move here")
    best = req.get("best")
    if best and ex.parse_move(board, best) == move:
        # you played lichess's move: still explain that move, against the best other move
        infos = ENGINE.analyse(board, chess.engine.Limit(nodes=NODES), multipv=2)
        move = next(i["pv"][0] for i in infos if i["pv"][0] != move)
    facts = ex.build_facts(req["fen"], move.uci(), best, NODES, ENGINE)
    line = lambda k: {"move": facts[k]["move"], "eval": facts[k]["latest_sf_eval"], "line": facts[k]["line_with_evals"]}
    if abs(facts["latest_sf_gap"]) < EQUAL_GAP:
        # the engines' lines differ for reasons too small to explain; a story would only invent one
        text = (f"**{facts['played']['move']}** is about as good as **{facts['alternative']['move']}**: the difference is "
                f"{abs(facts['latest_sf_gap']):.2f} pawns, which is within the engine's noise. Either move is fine.")
    else:
        text = ex.explain(facts, "high", api_key)
    return {"text": text, "best": line("alternative"), "compared": line("played")}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Any web page can POST to localhost; only extension pages may spend engine time and API credits.
        if not self.headers.get("Origin", "").startswith("chrome-extension://") or self.path != "/explain":
            return self.reply(403, {"error": "forbidden"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.reply(200, handle(req, self.headers.get("X-Anthropic-Key") or None))
        except anthropic.AuthenticationError:
            self.reply(401, {"error": "Anthropic rejected the API key. Check it in the panel settings."})
        except Refused as e:
            self.reply(403, {"error": str(e)})
        except Exception as e:
            self.reply(400, {"error": f"{type(e).__name__}: {e}"})

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    ENGINE = ex.open_engine()
    print(f"listening on http://127.0.0.1:{args.port}")
    try:
        HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    finally:
        ENGINE.quit()
