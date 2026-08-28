import struct
import zlib
import math

def create_png(width, height, output_path):
    raw_data = bytearray()
    
    for y in range(height):
        raw_data.append(0) # filter type 0 (None)
        for x in range(width):
            # Center coordinates from -1.0 to 1.0
            nx = (x / (width - 1)) * 2 - 1
            ny = (y / (height - 1)) * 2 - 1
            dist = math.sqrt(nx*nx + ny*ny)
            
            # Rounded rect background (#131317) with Amber border and golden microphone shape
            if max(abs(nx), abs(ny)) < 0.85:
                # Inside card
                if dist < 0.45:
                    # Gold microphone circle (#d97706)
                    r, g, b, a = 217, 119, 6, 255
                elif dist < 0.48:
                    # White highlight ring
                    r, g, b, a = 255, 255, 255, 255
                else:
                    # Dark pro background (#131317)
                    r, g, b, a = 19, 19, 23, 255
            else:
                # Transparent outside
                r, g, b, a = 0, 0, 0, 0
                
            raw_data.extend([r, g, b, a])
            
    # PNG format structure
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    header = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    idat = chunk(b"IDAT", zlib.compress(bytes(raw_data)))
    iend = chunk(b"IEND", b"")

    with open(output_path, "wb") as f:
        f.write(header + ihdr + idat + iend)

create_png(512, 512, "tauri/app-icon.png")
print("[OK] app-icon.png generated successfully")
