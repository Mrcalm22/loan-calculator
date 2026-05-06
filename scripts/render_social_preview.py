from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
BASE = ASSETS / "social-base.png"
OUTPUT = ASSETS / "social-preview.png"


def font(size: int, bold: bool = False):
  candidates = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
  ]
  for path in candidates:
    try:
      return ImageFont.truetype(path, size=size)
    except OSError:
      continue
  return ImageFont.load_default()


def rounded_rect(draw, box, radius, fill, outline=None, width=1):
  draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main():
  image = Image.open(BASE).convert("RGBA").resize((1200, 630))
  overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
  draw = ImageDraw.Draw(overlay)

  rounded_rect(draw, (56, 54, 584, 576), 34, (255, 251, 244, 234), outline=(255, 255, 255, 220), width=2)
  rounded_rect(draw, (614, 78, 1128, 552), 30, (255, 252, 246, 228), outline=(255, 255, 255, 215), width=2)

  rounded_rect(draw, (92, 108, 250, 152), 22, (31, 107, 83, 235))
  draw.text((122, 118), "LOAN CALCULATOR", fill=(255, 252, 246), font=font(18, True))

  draw.text((92, 196), "组合贷提前还款计算器", fill=(31, 42, 31), font=font(50, True))
  draw.text((92, 272), "支持公积金、商贷、LPR 重定价", fill=(95, 108, 98), font=font(26))
  draw.text((92, 314), "按当前账单月供校准，直接判断提前还值不值", fill=(95, 108, 98), font=font(26))

  pill_specs = [
    ((92, 376, 274, 430), "LPR 场景友好", (31, 107, 83, 225), (255, 252, 246)),
    ((288, 376, 474, 430), "账单月供校准", (255, 255, 255, 212), (31, 42, 31)),
  ]
  for box, text, fill, color in pill_specs:
    rounded_rect(draw, box, 24, fill, outline=(220, 214, 201, 235))
    draw.text((box[0] + 26, box[1] + 15), text, fill=color, font=font(22, True))

  rounded_rect(draw, (92, 466, 536, 528), 22, (255, 255, 255, 210), outline=(222, 213, 199, 235))
  draw.text((120, 490), "更适合中国房贷用户做真实账单口径的提前还款判断", fill=(95, 108, 98), font=font(20))

  cards = [
    ((646, 112, 1080, 202), "当前剩余本金", "¥2,306,640"),
    ((646, 224, 1080, 344), "更建议方案", "缩短年限"),
    ((646, 372, 848, 494), "预估节省利息", "¥167,921"),
    ((878, 372, 1080, 494), "隐含年化回报", "3.25%"),
  ]
  for box, label, value in cards:
    rounded_rect(draw, box, 24, (255, 255, 255, 210), outline=(222, 213, 199, 230))
    draw.text((box[0] + 24, box[1] + 22), label, fill=(95, 108, 98), font=font(18))
    value_font = font(38 if len(value) < 8 else 32, True)
    draw.text((box[0] + 24, box[1] + 56), value, fill=(31, 42, 31), font=value_font)

  draw.text((646, 520), "GitHub Pages · 纯静态前端 · 无后端依赖", fill=(95, 108, 98), font=font(18))

  result = Image.alpha_composite(image, overlay).convert("RGB")
  result.save(OUTPUT, quality=95)
  print(OUTPUT)


if __name__ == "__main__":
  main()
