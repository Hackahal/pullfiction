-- The planner uses the client's native roots and tooltip widgets. Its nameplate and raid
-- scripts create their own children, so the hidden login screens and avatar HUD are unnecessary.
local face = 'Fonts\\FRIZQT__.TTF'

-- Short labels consumed by the native unit-tooltip builder. Keep a supplied client-locale
-- value when present; the planner's English defaults need no hidden HUD program to define them.
local labels = {
    TOOLTIP_UNIT_LEVEL = 'Level %s',
    TOOLTIP_UNIT_LEVEL_CLASS = 'Level %s %s',
    TOOLTIP_UNIT_LEVEL_TYPE = 'Level %s (%s)',
    TOOLTIP_UNIT_LEVEL_CLASS_TYPE = 'Level %s %s (%s)',
    UNKNOWNOBJECT = 'Unknown', CORPSE = 'Corpse', CORPSE_TOOLTIP = 'Corpse of %s',
    PLAYER = 'Player', PLAYER_OFFLINE = 'Offline', ELITE = 'Elite', BOSS = 'Boss',
    PVP_ENABLED = 'PvP', RESURRECTABLE = 'Resurrectable', UNIT_SKINNABLE = 'Skinnable',
    PVP_RANK_CIVILIAN = 'Civilian', PVP_RANK_LEADER = 'Leader',
    UNITNAME_TITLE_PET = "%s's Pet", UNITNAME_TITLE_GUARDIAN = "%s's Guardian",
    UNITNAME_TITLE_CREATION = "%s's Creation",
}
for key, value in pairs(labels) do
    if getglobal(key) == nil then setglobal(key, value) end
end

CreateFrame('WorldFrame', 'WorldFrame')
WorldFrame:SetAllPoints()
WorldFrame:SetMovable(true)
WorldFrame:SetResizable(true)

CreateFrame('Frame', 'UIParent')
UIParent:SetAllPoints()
UIParent:SetFrameStrata('MEDIUM')

local header = CreateFont('GameTooltipHeaderText')
header:SetFont(face, 14)
header:SetJustifyH('LEFT')
header:SetTextColor(1, 1, 1)
local body = CreateFont('GameTooltipText')
body:SetFont(face, 12)
body:SetJustifyH('LEFT')
body:SetTextColor(1, 1, 1)

CreateFrame('GameTooltip', 'GameTooltip', UIParent)
GameTooltip:SetFrameStrata('TOOLTIP')
GameTooltip:SetClampedToScreen(true)
GameTooltip:SetBackdrop({
    bgFile = 'Interface\\Tooltips\\UI-Tooltip-Background',
    edgeFile = 'Interface\\Tooltips\\UI-Tooltip-Border',
    tile = true, tileSize = 16, edgeSize = 16,
    insets = { left = 5, right = 5, top = 5, bottom = 5 },
})

-- The native tooltip engine measures and places these line pairs. Its line capacity comes
-- from the pairs registered here; the existing engine tests use this same thirty-line ladder.
for i = 1, 30 do
    local left = GameTooltip:CreateFontString('GameTooltipTextLeft'..i, 'ARTWORK')
    local right = GameTooltip:CreateFontString('GameTooltipTextRight'..i, 'ARTWORK')
    left:SetFontObject(i == 1 and header or body)
    right:SetFontObject(i == 1 and header or body)
    if i == 1 then
        left:SetPoint('TOPLEFT', GameTooltip, 'TOPLEFT', 10, -10)
    else
        left:SetPoint('TOPLEFT', getglobal('GameTooltipTextLeft'..(i-1)), 'BOTTOMLEFT', 0, -2)
    end
    right:SetPoint('RIGHT', left, 'LEFT', 40, 0)
    left:Hide()
    right:Hide()
    GameTooltip:AddFontStrings(left, right)
end

local function resetTooltip()
    GameTooltip:SetBackdropBorderColor(1, 1, 1)
    GameTooltip:SetBackdropColor(0.09, 0.09, 0.19)
    GameTooltip.default = nil
end
resetTooltip()
GameTooltip:SetScript('OnHide', resetTooltip)
GameTooltip:SetScript('OnTooltipSetDefaultAnchor', function()
    GameTooltip:SetOwner(UIParent, 'ANCHOR_NONE')
    GameTooltip:SetPoint('BOTTOMRIGHT', UIParent, 'BOTTOMRIGHT', -13, 70)
    GameTooltip.default = 1
end)

local health = CreateFrame('StatusBar', 'GameTooltipStatusBar', GameTooltip)
health:SetHeight(8)
health:SetPoint('TOPLEFT', GameTooltip, 'BOTTOMLEFT', 2, -1)
health:SetPoint('TOPRIGHT', GameTooltip, 'BOTTOMRIGHT', -2, -1)
health:SetStatusBarTexture('Interface\\TargetingFrame\\UI-TargetingFrame-BarFill')
health:SetScript('OnValueChanged', function()
    local lo, hi = this:GetMinMaxValues()
    if arg1 and arg1 >= lo and arg1 <= hi then this:SetStatusBarColor(0, 1, 0) end
end)
health:Hide()

-- The original native mouseover builder publishes its unit before this event. Its title
-- follows the same faction colours as the stock tooltip, independently of planner class colours.
local reactions = {
    {0.8,0.3,0.22}, {0.8,0.3,0.22}, {0.75,0.27,0}, {0.9,0.7,0},
    {0,0.6,0.1}, {0,0.6,0.1}, {0,0.6,0.1}, {0,0.6,0.1},
}
GameTooltip:RegisterEvent('UPDATE_MOUSEOVER_UNIT')
GameTooltip:SetScript('OnEvent', function()
    if event ~= 'UPDATE_MOUSEOVER_UNIT' then return end
    local color
    if UnitPlayerControlled('mouseover') then
        local attacks = UnitCanAttack('mouseover', 'player')
        local attacked = UnitCanAttack('player', 'mouseover')
        if attacks and attacked then
            color = reactions[2]
        elseif not attacks and attacked then
            color = reactions[4]
        elseif not attacks and UnitIsPVP('mouseover') then
            color = reactions[6]
        end
    else
        color = reactions[UnitReaction('mouseover', 'player')]
    end
    if color then GameTooltipTextLeft1:SetTextColor(unpack(color))
    else GameTooltipTextLeft1:SetTextColor(1, 1, 1) end
end)
GameTooltip:Hide()
