-- Pull Fiction's client UI. State is supplied by replay entities, never a wall-clock OnUpdate.
PullFictionPlates = {}
local white = 'Interface\\Buttons\\WHITE8X8'
local font = 'Fonts\\FRIZQT__.TTF'
local function texture(parent, layer, r, g, b, a)
    local t = parent:CreateTexture(nil, layer)
    t:SetTexture(white); t:SetVertexColor(r, g, b, a)
    return t
end
local function text(parent)
    local t = parent:CreateFontString(nil, 'OVERLAY')
    t:SetFont(font, 9, 'OUTLINE'); t:SetJustifyH('LEFT')
    t:SetTextColor(0.95, 0.96, 0.98, 1)
    return t
end
local function make(key)
    local f = CreateFrame('Button', nil, WorldFrame)
    f:SetFrameStrata('LOW'); f:SetFrameLevel(12)
    f:RegisterForClicks('LeftButtonUp'); f:EnableMouse(true)
    f:SetScript('OnClick', function() PullFictionPlateClick = this.key end)
    f:SetScript('OnEnter', function() this.hover = true end)
    f:SetScript('OnLeave', function() this.hover = nil end)
    f.key = key
    f.edge = texture(f, 'BACKGROUND', 0.04, 0.05, 0.07, 1)
    f.background = texture(f, 'BORDER', 0.09, 0.11, 0.14, 0.97)
    f.fill = texture(f, 'ARTWORK', 0.8, 0.3, 0.2, 1)
    f.name = text(f); f.hp = text(f)
    f.castback = texture(f, 'BORDER', 0.08, 0.07, 0.05, 0.98)
    f.castfill = texture(f, 'ARTWORK', 0.86, 0.63, 0.27, 1)
    f.casttext = text(f); f.casttime = text(f)
    f.castic = f:CreateTexture(nil, 'ARTWORK')
    f.icons = {}
    for i = 1, 4 do
        local icon = CreateFrame('Frame', nil, f); icon:SetFrameLevel(13)
        icon.bg = texture(icon, 'BACKGROUND', 0.06, 0.08, 0.12, 1)
        icon.tex = icon:CreateTexture(nil, 'ARTWORK'); icon.tex:SetAllPoints(icon)
        icon.stack = text(icon); icon.stack:SetJustifyH('RIGHT')
        icon.stack:SetPoint('BOTTOMRIGHT', icon, 'BOTTOMRIGHT', 0, 0)
        icon:Hide(); f.icons[i] = icon
    end
    return f
end
local function rect(t, f, x, y, w, h)
    t:ClearAllPoints(); t:SetPoint('TOPLEFT', f, 'TOPLEFT', x, -y)
    t:SetWidth(math.max(w, 0.1)); t:SetHeight(h)
end
function PullFictionPlates_Update(units, u, looking)
    for key, f in pairs(PullFictionPlates) do f.seen = nil end
    for _, d in ipairs(units) do
        local f = PullFictionPlates[d.key]
        if not f then f = make(d.key); PullFictionPlates[d.key] = f end
        f.seen = true
        local w, h = d.w*u, d.h*u
        f:ClearAllPoints(); f:SetPoint('TOPLEFT', WorldFrame, 'TOPLEFT', d.x*u, -d.y*u)
        f:SetWidth(w); f:SetHeight(h); f:EnableMouse(not looking)
        local r, g, b = d.r, d.g, d.b
        local iconrow = table.getn(d.auras) > 0 and 18*u or 0
        local namey = iconrow
        local barY = namey+13*u
        local barH = d.friendly and 5*u or 10*u
        if d.selected then barH = 10*u end
        f.edge:SetVertexColor(d.selected and 1 or 0.015, d.selected and 0.79 or 0.02, d.selected and 0.3 or 0.03, 1)
        rect(f.edge, f, -u, barY-u, w+2*u, barH+2*u)
        rect(f.background, f, 0, barY, w, barH)
        rect(f.fill, f, 0, barY, w*d.health, barH)
        f.fill:SetVertexColor(r, g, b, 1)
        if d.health <= 0 then f.fill:Hide() else f.fill:Show() end
        f.name:ClearAllPoints(); f.name:SetPoint('TOPLEFT', f, 'TOPLEFT', 0, -namey)
        f.name:SetWidth(w); f.name:SetHeight(12*u); f.name:SetFont(font, (d.friendly and 10 or 11)*u, 'OUTLINE')
        f.name:SetText(d.name); f.name:SetTextColor(d.friendly and math.min(1,r+0.18) or 1, d.friendly and math.min(1,g+0.18) or 0.92, d.friendly and math.min(1,b+0.18) or 0.85, 1)
        f.hp:SetFont(font, 8*u, 'OUTLINE'); f.hp:SetJustifyH('RIGHT')
        f.hp:ClearAllPoints(); f.hp:SetPoint('RIGHT', f, 'TOPRIGHT', -2*u, -barY-barH/2)
        f.hp:SetWidth(38*u); f.hp:SetHeight(10*u)
        if not d.friendly or d.selected then f.hp:SetText(d.hptext); f.hp:Show() else f.hp:Hide() end
        if d.cast then
            local cy = barY+barH+4*u; local ch = 10*u
            rect(f.castback, f, 0, cy, w, ch)
            rect(f.castfill, f, 0, cy, w*d.cast.progress, ch)
            rect(f.castic, f, -13*u, cy-u, 12*u, 12*u)
            f.castic:SetTexture(d.cast.icon); f.castic:SetTexCoord(0.07,0.93,0.07,0.93)
            f.casttext:SetFont(font, 8*u, 'OUTLINE'); f.casttext:ClearAllPoints()
            f.casttext:SetPoint('TOPLEFT', f, 'TOPLEFT', 2*u, -cy)
            f.casttext:SetWidth(w-28*u); f.casttext:SetHeight(ch); f.casttext:SetText(d.cast.name)
            f.casttime:SetFont(font, 8*u, 'OUTLINE'); f.casttime:ClearAllPoints()
            f.casttime:SetPoint('TOPRIGHT', f, 'TOPRIGHT', -2*u, -cy)
            f.casttime:SetWidth(25*u); f.casttime:SetHeight(ch); f.casttime:SetText(d.cast.remaining)
            f.casttime:SetJustifyH('RIGHT')
            f.castback:Show(); f.castfill:Show(); f.casttext:Show(); f.casttime:Show(); f.castic:Show()
        else
            f.castback:Hide(); f.castfill:Hide(); f.casttext:Hide(); f.casttime:Hide(); f.castic:Hide()
        end
        for i = 1, 4 do
            local a = d.auras[i]; local icon = f.icons[i]
            if a then
                icon:ClearAllPoints(); icon:SetPoint('TOPLEFT', f, 'TOPLEFT', (i-1)*18*u, 0)
                icon:SetWidth(15*u); icon:SetHeight(15*u)
                rect(icon.bg, icon, -u, -u, 17*u, 17*u)
                icon.bg:SetVertexColor(a.debuff and 0.85 or 0.15, a.debuff and 0.23 or 0.5, a.debuff and 0.18 or 0.8, 1)
                icon.tex:SetTexture(a.icon); icon.tex:SetTexCoord(0.07,0.93,0.07,0.93)
                icon.stack:SetFont(font, 8*u, 'OUTLINE'); icon.stack:SetText(a.stack>1 and tostring(a.stack) or '')
                icon:Show()
            else icon:Hide() end
        end
        f:SetAlpha(d.selected and 1 or (d.friendly and 0.92 or 1)); f:Show()
    end
    for key, f in pairs(PullFictionPlates) do if not f.seen then f:Hide() end end
end
