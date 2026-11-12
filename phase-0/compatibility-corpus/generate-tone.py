"""Generate a three-second synthetic mono WAV for Resolve compatibility checks."""

import math
import struct
import sys
import wave


with wave.open(sys.argv[1], "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(48_000)
    for frame in range(3 * 48_000):
        sample = int(7000 * math.sin(2 * math.pi * 440 * frame / 48_000))
        output.writeframesraw(struct.pack("<h", sample))
