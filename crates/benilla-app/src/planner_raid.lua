-- Compact class-colour raid frames, rendered natively in the planner. The 1.12
-- client has no modern CompactUnitFrame template; this is our presentation layer.
PullFictionRaid = {}
local font='Fonts\\FRIZQT__.TTF'
local white='Interface\\Buttons\\WHITE8X8'
local colors={[1]={.78,.61,.43},[2]={.96,.55,.73},[3]={.67,.83,.45},[4]={1,.96,.41},[5]={.95,.95,.95},[7]={.1,.4,.95},[8]={.41,.8,.94},[9]={.58,.51,.79},[11]={1,.49,.04}}
local powercolors={[0]={.08,.3,.95},[1]={.85,.12,.12},[2]={1,.5,.25},[3]={1,.85,.12},[4]={.1,.7,.7}}
local function rect(o,p,x,y,w,h)
 w=math.max(.1,w)
 local old=o._pfRect
 if old and old[1]==p and old[2]==x and old[3]==y and old[4]==w and old[5]==h then return end
 o:ClearAllPoints();o:SetPoint('TOPLEFT',p,'TOPLEFT',x,-y);o:SetWidth(w);o:SetHeight(h)
 o._pfRect={p,x,y,w,h}
end
-- These widgets are owned here: keep exact arguments across payload changes so an unrelated
-- cast/health update does not re-anchor, resize and re-shape every member's labels.
local function setfont(o,size)
 if o._pfFontSize==size then return end
 if o:SetFont(font,size,'OUTLINE') then o._pfFontSize=size end
end
local function settext(o,value)
 if o._pfText==value then return end
 o:SetText(value);o._pfText=value
end
local function texture(p,layer,r,g,b,a)
 local t=p:CreateTexture(nil,layer);t:SetTexture(white);t:SetVertexColor(r,g,b,a);return t
end
local function text(p)
 local t=p:CreateFontString(nil,'OVERLAY');setfont(t,10);t:SetJustifyH('LEFT');t:SetTextColor(1,1,1,1);return t
end
local function make(index)
 if GameTooltip then GameTooltip:SetParent(WorldFrame) end
 local f=CreateFrame('Button','PullFictionRaidUnit'..index,WorldFrame)
 f:SetFrameStrata('MEDIUM');f:SetFrameLevel(18);f:EnableMouse(true);f:RegisterForClicks('LeftButtonUp','RightButtonUp')
 f:SetScript('OnClick',function() if arg1=='RightButton' then PullFictionRaidFocus=this.guid else PullFictionPlateClick=this.guid end end)
 f:SetScript('OnDoubleClick',function() if arg1=='LeftButton' then PullFictionPlateClick=this.guid;PullFictionRaidFocus=this.guid else PullFictionRaidFocus=this.guid end end)
 f.edge=texture(f,'BACKGROUND',0,0,0,1);f.background=texture(f,'BORDER',.07,.08,.09,1)
 f.health=CreateFrame('StatusBar',nil,f);f.health:SetFrameLevel(19);f.health:SetStatusBarTexture(white)
 -- Overlay text and aura children above the actual health status bar.
 f.overlay=CreateFrame('Frame',nil,f);f.overlay:SetAllPoints(f);f.overlay:SetFrameLevel(20);f.overlay:EnableMouse(false)
 f.name=text(f.overlay);f.hp=text(f.overlay);f.hp:SetJustifyH('RIGHT')
 f.power=CreateFrame('StatusBar',nil,f);f.power:SetFrameLevel(19);f.power:SetStatusBarTexture(white);f.power:SetStatusBarColor(.08,.3,.8)
 f.powerbg=texture(f,'BORDER',.08,.09,.12,1);f.powertext=text(f.overlay)
 f.castbg=texture(f,'BORDER',.04,.035,.02,1);f.castfill=texture(f,'ARTWORK',.76,.59,.28,1);f.castname=text(f.overlay)
 f.more=text(f.overlay);f.icons={}
 for n=1,6 do
  local a=CreateFrame('Frame',nil,f);a:SetFrameLevel(22);a:EnableMouse(true)
  a.edge=texture(a,'BACKGROUND',0,0,0,1);a.image=a:CreateTexture(nil,'ARTWORK');a.image:SetAllPoints(a)
  a.stack=text(a);a.stack:SetJustifyH('RIGHT');a.stack:SetPoint('BOTTOMRIGHT',a,'BOTTOMRIGHT',1,-1)
  a:SetScript('OnEnter',function() if this.aura and GameTooltip then GameTooltip:SetOwner(this,'ANCHOR_RIGHT');GameTooltip:SetText(this.aura.name);if this.aura.stack>1 then GameTooltip:AddLine('Stacks: '..this.aura.stack,1,1,1) end;GameTooltip:Show() end end)
  a:SetScript('OnLeave',function() if GameTooltip then GameTooltip:Hide() end end)
  a:Hide();f.icons[n]=a
 end
 return f
end
function PullFictionRaid_Update(units,enabled,u,rowcount,scale)
 local origin=u;rowcount=rowcount or 5;u=u*(scale or 1)
 for _,f in pairs(PullFictionRaid) do f.seen=nil end
 if enabled then
  for i,d in ipairs(units) do
   local f=PullFictionRaid[i];if not f then f=make(i);PullFictionRaid[i]=f end
   f.seen=true;f.guid=d.guid
   rect(f,WorldFrame,12*origin+math.floor((i-1)/rowcount)*91*u,12*origin+math.mod(i-1,rowcount)*56*u,87*u,52*u)
   rect(f.edge,f,0,0,87*u,52*u);f.edge:SetVertexColor(d.selected and 1 or .02,d.selected and .82 or .02,d.selected and .35 or .02,1)
   rect(f.background,f,u,u,85*u,50*u)
   local c=colors[d.class] or {.6,.6,.6}
   rect(f.health,f,2*u,2*u,83*u,32*u);f.health:SetMinMaxValues(0,d.max);f.health:SetValue(d.hp);f.health:SetStatusBarColor(c[1],c[2],c[3])
   rect(f.powerbg,f,2*u,34*u,83*u,8*u)
   rect(f.power,f,2*u,34*u,83*u,8*u);f.power:SetMinMaxValues(0,math.max(1,d.maxpower));f.power:SetValue(d.power)
   local pc=powercolors[d.powertype or 0] or powercolors[0];f.power:SetStatusBarColor(pc[1],pc[2],pc[3])
   rect(f.powertext,f,4*u,33*u,79*u,10*u);setfont(f.powertext,7*u);f.powertext:SetJustifyH('CENTER');settext(f.powertext,d.maxpower>0 and ((d.powerknown==false and '?' or tostring(math.floor(d.power)))..' / '..tostring(math.floor(d.maxpower))) or '--')
   rect(f.name,f,5*u,4*u,77*u,12*u);setfont(f.name,10*u);settext(f.name,d.name)
   rect(f.hp,f,5*u,19*u,77*u,11*u);setfont(f.hp,9*u);settext(f.hp,d.hp==0 and 'Dead' or '')
   if d.cast then
    rect(f.castbg,f,2*u,44*u,83*u,6*u);rect(f.castfill,f,2*u,44*u,83*u*d.cast.progress,6*u)
    rect(f.castname,f,4*u,43*u,80*u,8*u);setfont(f.castname,7*u);settext(f.castname,d.cast.name)
    f.castbg:Show();f.castfill:Show();f.castname:Show()
   else f.castbg:Hide();f.castfill:Hide();f.castname:Hide() end
   local visible={};local debuffs=0;local buffs=0
   for _,a in ipairs(d.auras) do if a.debuff and debuffs<3 then table.insert(visible,a);debuffs=debuffs+1 end end
   for _,a in ipairs(d.auras) do if not a.debuff and buffs<3 then table.insert(visible,a);buffs=buffs+1 end end
   for n=1,6 do
    local icon=f.icons[n];local a=visible[n];icon.aura=a
    if a then
     local x=a.debuff and (4+(n-1)*12) or (83-(n-debuffs)*12)
     rect(icon,f,x*u,20*u,10*u,10*u);rect(icon.edge,icon,-u,-u,12*u,12*u)
     icon.edge:SetVertexColor(a.debuff and .8 or .04,a.debuff and .12 or .04,a.debuff and .08 or .04,1)
     icon.image:SetTexture(a.icon);icon.image:SetTexCoord(.07,.93,.07,.93);setfont(icon.stack,7*u);settext(icon.stack,a.stack>1 and tostring(a.stack) or '');icon:Show()
    else icon:Hide() end
   end
   f:SetAlpha(d.hp==0 and .5 or 1);f:Show()
  end
 end
 for _,f in pairs(PullFictionRaid) do if not f.seen then f:Hide() end end
end
