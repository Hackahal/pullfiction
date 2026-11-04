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
-- These private widgets retain exact arguments. Camera movement changes the
-- parent anchor, not every font, texture and child rectangle on the plate.
local function anchor(o, point, parent, relative, x, y)
    local old=o._pfAnchor
    if old and old[1]==point and old[2]==parent and old[3]==relative and old[4]==x and old[5]==y then return end
    o:ClearAllPoints(); o:SetPoint(point,parent,relative,x,y)
    o._pfAnchor={point,parent,relative,x,y}
end
local function size(o,w,h)
    if o._pfWidth~=w then o:SetWidth(w);o._pfWidth=w end
    if o._pfHeight~=h then o:SetHeight(h);o._pfHeight=h end
end
local function rect(o,p,x,y,w,h)
    anchor(o,'TOPLEFT',p,'TOPLEFT',x,-y);size(o,math.max(w,0.1),h)
end
local function setfont(o,value)
    if o._pfFontSize==value then return end
    if o:SetFont(font,value,'OUTLINE') then o._pfFontSize=value end
end
local function settext(o,value)
    if o._pfText==value then return end
    o:SetText(value);o._pfText=value
end
local function settexture(o,value)
    if o._pfTexture==value then return end
    if o:SetTexture(value) then o._pfTexture=value end
end
local function rgba(o,method,r,g,b,a)
    local old=o._pfColor
    if old and old[1]==method and old[2]==r and old[3]==g and old[4]==b and old[5]==a then return end
    o[method](o,r,g,b,a);o._pfColor={method,r,g,b,a}
end
local function shown(o,value)
    if o._pfShown==value then return end
    if value then o:Show() else o:Hide() end
    o._pfShown=value
end
local function crop(o)
    if o._pfCrop then return end
    o:SetTexCoord(0.07,0.93,0.07,0.93);o._pfCrop=true
end
function PullFictionPlates_Update(units, u, looking)
    for key, f in pairs(PullFictionPlates) do f.seen = nil end
    for _, d in ipairs(units) do
        local f = PullFictionPlates[d.key]
        if not f then f = make(d.key); PullFictionPlates[d.key] = f end
        f.seen = true
        local w, h = d.w*u, d.h*u
        rect(f,WorldFrame,d.x*u,d.y*u,w,h)
        if f._pfMouse~=(not looking) then f:EnableMouse(not looking);f._pfMouse=not looking end
        local r, g, b = d.r, d.g, d.b
        local iconrow = table.getn(d.auras) > 0 and 18*u or 0
        local namey = iconrow
        local barY = namey+13*u
        local barH = d.friendly and 5*u or 10*u
        if d.selected then barH = 10*u end
        rgba(f.edge,'SetVertexColor',d.selected and 1 or 0.015, d.selected and 0.79 or 0.02, d.selected and 0.3 or 0.03, 1)
        shown(f.edge,true); shown(f.background,true)
        rect(f.edge, f, -u, barY-u, w+2*u, barH+2*u)
        rect(f.background, f, 0, barY, w, barH)
        rect(f.fill, f, 0, barY, w*d.health, barH)
        rgba(f.fill,'SetVertexColor',r,g,b,1)
        shown(f.fill,d.health>0)
        anchor(f.name,'TOPLEFT',f,'TOPLEFT',0,-namey)
        size(f.name,w,12*u);setfont(f.name,(d.friendly and 10 or 11)*u)
        settext(f.name,d.name); rgba(f.name,'SetTextColor',d.friendly and math.min(1,r+0.18) or 1, d.friendly and math.min(1,g+0.18) or 0.92, d.friendly and math.min(1,b+0.18) or 0.85, 1)
        setfont(f.hp,8*u);if not f.hp._pfRight then f.hp:SetJustifyH('RIGHT');f.hp._pfRight=true end
        anchor(f.hp,'RIGHT',f,'TOPRIGHT',-2*u,-barY-barH/2)
        size(f.hp,38*u,10*u)
        if not d.friendly or d.selected then settext(f.hp,d.hptext);shown(f.hp,true) else shown(f.hp,false) end
        if d.cast then
            local cy = barY+barH+4*u; local ch = 10*u
            rect(f.castback, f, 0, cy, w, ch)
            rect(f.castfill, f, 0, cy, w*d.cast.progress, ch)
            rect(f.castic, f, -13*u, cy-u, 12*u, 12*u)
            settexture(f.castic,d.cast.icon);crop(f.castic)
            setfont(f.casttext,8*u);anchor(f.casttext,'TOPLEFT',f,'TOPLEFT',2*u,-cy)
            size(f.casttext,w-28*u,ch);settext(f.casttext,d.cast.name)
            setfont(f.casttime,8*u);anchor(f.casttime,'TOPRIGHT',f,'TOPRIGHT',-2*u,-cy)
            size(f.casttime,25*u,ch);settext(f.casttime,d.cast.remaining)
            if not f.casttime._pfRight then f.casttime:SetJustifyH('RIGHT');f.casttime._pfRight=true end
            shown(f.castback,true);shown(f.castfill,true);shown(f.casttext,true);shown(f.casttime,true);shown(f.castic,true)
        else
            shown(f.castback,false);shown(f.castfill,false);shown(f.casttext,false);shown(f.casttime,false);shown(f.castic,false)
        end
        for i = 1, 4 do
            local a = d.auras[i]; local icon = f.icons[i]
            if a then
                anchor(icon,'TOPLEFT',f,'TOPLEFT',(i-1)*18*u,0);size(icon,15*u,15*u)
                rect(icon.bg, icon, -u, -u, 17*u, 17*u)
                rgba(icon.bg,'SetVertexColor',a.debuff and 0.85 or 0.15, a.debuff and 0.23 or 0.5, a.debuff and 0.18 or 0.8, 1)
                settexture(icon.tex,a.icon);crop(icon.tex)
                setfont(icon.stack,8*u);settext(icon.stack,a.stack>1 and tostring(a.stack) or '')
                shown(icon,true)
            else shown(icon,false) end
        end
        if d.name_only then
            shown(f.edge,false);shown(f.background,false);shown(f.fill,false);shown(f.hp,false)
            shown(f.castback,false);shown(f.castfill,false);shown(f.casttext,false);shown(f.casttime,false);shown(f.castic,false)
            for i=1,4 do shown(f.icons[i],false) end
        end
        local alpha=d.selected and 1 or (d.friendly and 0.92 or 1)
        if f._pfAlpha~=alpha then f:SetAlpha(alpha);f._pfAlpha=alpha end
        shown(f,true)
    end
    for key, f in pairs(PullFictionPlates) do if not f.seen then shown(f,false) end end
end
