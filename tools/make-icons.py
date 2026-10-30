"""生成扩展图标：深色圆角底 + 金色阶梯尖塔。"""
from PIL import Image, ImageDraw

BG = (27, 26, 23, 255)
GOLD = (216, 169, 74, 255)
GOLD_DARK = (150, 112, 44, 255)
EDGE = (58, 54, 48, 255)


def rounded(size, radius):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG, outline=EDGE, width=max(1, size // 32))
    return img


def draw_spire(img, size):
    """阶梯尖塔：自下而上逐级收窄，各段上下相接不留缝。"""
    d = ImageDraw.Draw(img)
    cx = size / 2.0
    line = max(1, size // 48)

    # 基座（最宽，作为底座）
    pedestal_top = size * 0.68
    pedestal_bottom = size * 0.84
    d.rectangle([cx - size * 0.30, pedestal_top, cx + size * 0.30, pedestal_bottom], fill=GOLD_DARK)

    # 三段塔身，每段底边与下一段顶边重合
    tiers = [
        (0.52, 0.68, 0.25),  # (顶 y, 底 y, 半宽) 以 size 比例
        (0.40, 0.54, 0.19),
        (0.30, 0.42, 0.13),
    ]
    for top, bottom, half in tiers:
        hw = size * half / 2.0
        d.rectangle([cx - hw, size * top, cx + hw, size * bottom], fill=GOLD)

    # 塔尖三角，底边与最上一段顶边重合
    tip_bottom = size * 0.32
    tip_hw = size * 0.13 / 2.0
    d.polygon(
        [(cx, size * 0.12), (cx - tip_hw, tip_bottom), (cx + tip_hw, tip_bottom)],
        fill=GOLD,
    )

    # 每级台阶的分界线（横向暗线，增强阶梯感）
    for top, _bottom, half in tiers:
        hw = size * half / 2.0
        d.rectangle([cx - hw, size * top, cx + hw, size * top + line], fill=GOLD_DARK)

    # 顶部星点
    r = max(1, size // 26)
    d.ellipse([cx - r, size * 0.08 - r, cx + r, size * 0.08 + r], fill=(255, 242, 205, 255))


for s in (16, 32, 48, 128):
    radius = max(2, int(s * 0.18))
    img = rounded(s, radius)
    if s <= 32:
        # 小尺寸减少细节，避免糊成一团
        d = ImageDraw.Draw(img)
        cx = s / 2.0
        d.polygon(
            [(cx, s * 0.12), (cx - s * 0.20, s * 0.44), (cx + s * 0.20, s * 0.44)],
            fill=GOLD,
        )
        d.rectangle([cx - s * 0.16, s * 0.44, cx + s * 0.16, s * 0.80], fill=GOLD)
        d.rectangle([cx - s * 0.22, s * 0.80, cx + s * 0.22, s * 0.86], fill=GOLD_DARK)
    else:
        draw_spire(img, s)
    img.save(f"extension/icons/icon{s}.png")
    print("wrote icon%d.png" % s)
