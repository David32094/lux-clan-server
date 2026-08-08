import base64
import io
import re
from PIL import Image

with open("LUX_CLAN_EDITOR.html", "r", encoding="utf-8") as f:
    text = f.read()

m_tmpl = re.search(r'ENFRENT_TEMPLATE\s*=\s*"data:image/[^;]+;base64,([^"]+)"', text)
m_over = re.search(r'ENFRENT_OVERLAY\s*=\s*"data:image/[^;]+;base64,([^"]+)"', text)

im_tmpl = Image.open(io.BytesIO(base64.b64decode(m_tmpl.group(1)))).convert("RGBA")
im_over = Image.open(io.BytesIO(base64.b64decode(m_over.group(1)))).convert("RGBA")

# We want to find x, y, w, h such that drawing im_over resized to (w, h) at (x, y) on top of im_tmpl
# aligns the red lines of im_over with the red lines of im_tmpl

best_diff = float("inf")
best_coords = None

# Grid search around x: 0..30, y: 990..1050, w: 880..941, h: 540..600
for x in range(0, 30, 2):
    for y in range(990, 1050, 2):
        for w in range(880, 941, 5):
            for h in range(540, 600, 5):
                # Resize im_over
                over_resized = im_over.resize((w, h), Image.Resampling.BILINEAR)
                
                # Composite onto template
                canvas = im_tmpl.copy()
                canvas.alpha_composite(over_resized, (x, y))
                
                # Check red text 'RESULTADO' and red border alignment
                # Measure color difference in red channel around the border (y: y..y+40)
                diff = 0
                count = 0
                for cy in range(y, min(y + 60, canvas.height)):
                    for cx in range(x, min(x + w, canvas.width)):
                        r_tmpl, g_tmpl, b_tmpl, _ = im_tmpl.getpixel((cx, cy))
                        r_comp, g_comp, b_comp, _ = canvas.getpixel((cx, cy))
                        if r_tmpl > 100 and g_tmpl < 50: # red line in template
                            # measure displacement/ghosting
                            diff += abs(r_tmpl - r_comp) + abs(g_tmpl - g_comp)
                            count += 1
                if count > 0:
                    avg_diff = diff / count
                    if avg_diff < best_diff:
                        best_diff = avg_diff
                        best_coords = (x, y, w, h)

print(f"Best matching coordinates for overlay: X={best_coords[0]}, Y={best_coords[1]}, W={best_coords[2]}, H={best_coords[3]} (avg diff: {best_diff:.2f})")

# Save sample composite at best coords
best_x, best_y, best_w, best_h = best_coords
over_best = im_over.resize((best_w, best_h), Image.Resampling.LANCZOS)
canvas = im_tmpl.copy()
canvas.alpha_composite(over_best, (best_x, best_y))
canvas.save("best_overlay_match.png")
print("Saved best_overlay_match.png")
