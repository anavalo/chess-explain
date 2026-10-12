# /// script
# requires-python = ">=3.10"
# dependencies = ["chess", "anthropic"]
# ///
"""Checks the server's request handling with the LLM stubbed out (calls lichess for the status check).
usage: uv run test_server.py"""
import chess

import server
from explain import open_engine, trapped

server.importlib.reload = lambda m: m  # keep the stub below
server.ex.explain = lambda facts, effort: "(stub)"
server.ENGINE = open_engine()
fen = "r3k2r/1p1bbpp1/pqn1p2p/2ppP3/3P4/2PB1N2/PP1N1PPP/R2Q1RK1 w kq - 2 11"
# white bishop on a7: attacked by the rook, b6 is covered by the c7 pawn, b8 by the rook
assert trapped(chess.Board("r3k3/B1p5/1p6/8/8/8/8/4K3 w - - 0 1")) == [chess.A7]
assert trapped(chess.Board("r3k3/B7/1p6/8/8/8/8/4K3 w - - 0 1")) == []  # Bxb6 escapes
try:
    r = server.handle({"fen": fen, "move": "dxc5", "best": "c3c4", "user": "fable6"})
    assert (r["best"]["move"], r["compared"]["move"]) == ("c4", "dxc5"), r
    # compared move == lichess's move: lichess's move is still the one explained
    r = server.handle({"fen": fen, "move": "c4", "best": "c3c4", "user": "fable6"})
    assert r["best"]["move"] == "c4" and r["compared"]["move"] != "c4", r
    # equal moves: no LLM call, plain verdict
    r = server.handle({"fen": "r4rk1/p1p2pp1/1pnb1q1p/3p1b2/P2P4/1NP2N2/1P2BPPP/R2QR1K1 b - - 0 13", "move": "Rfe8",
                       "best": "c6e7", "user": "fable6"})
    assert "about as good as" in r["text"], r
    for bad in ({"user": None}, {"user": "zz_no_such_user_zz"}):
        try:
            server.handle({"fen": fen, "move": "dxc5", **bad})
            raise AssertionError(f"not refused: {bad}")
        except server.Refused:
            pass
    print("ok")
finally:
    server.ENGINE.quit()
