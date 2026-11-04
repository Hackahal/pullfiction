//! Run the production Lua against a recording widget host.
use benilla_ui::mlua::Lua;

pub(super) fn fixture(source: &str) -> Lua {
    let lua = Lua::new();
    lua.load(r#"
        ALL={};COUNTS={}
        local function widget()
            local o={last={},shown=true,id=table.getn(ALL)+1}
            table.insert(ALL,o)
            return setmetatable(o,{__index=function(self,k)
                if string.find(k,'^Create') then return function() return widget() end end
                if string.find(k,'^Set') or string.find(k,'^Clear') or string.find(k,'^Register')
                    or string.find(k,'^Enable') or k=='Show' or k=='Hide' then
                    local f=function(self,...)
                        COUNTS[k]=(COUNTS[k] or 0)+1
                        if k=='SetFont' and FAIL_FONTS then return nil end
                        if k=='SetTexture' and FAIL_TEXTURES then return nil end
                        if k=='Show' then self.shown=true elseif k=='Hide' then self.shown=false end
                        self.last[k]=arg
                        return true
                    end
                    rawset(self,k,f);return f
                end
            end})
        end
        WorldFrame=widget()
        function CreateFrame() return widget() end
        UNITS={{key='9007199254740993',name='Enemy',x=100,y=200,w=140,h=55,
            friendly=false,selected=false,name_only=false,r=.8,g=.3,b=.2,
            health=.75,hptext='75%',cast={name='Fire',icon='cast.blp',progress=.25,remaining='1.5'},
            auras={{icon='aura.blp',stack=2,debuff=true}}}}
        function SemanticSnapshot()
            local function value(v)
                if type(v)=='table' then
                    if v.id then return '# '..tostring(v.id) end
                    local s='['
                    for i=1,table.getn(v) do s=s..value(v[i])..',' end
                    return s..']'
                end
                if type(v)=='function' then return 'function' end
                return type(v)..':'..tostring(v)
            end
            local out=''
            for i,o in ipairs(ALL) do
                out=out..i..':'..tostring(o.shown)..'/'
                local keys={}
                for k in pairs(o.last) do if string.find(k,'^Set') or string.find(k,'^Enable') then table.insert(keys,k) end end
                table.sort(keys)
                for _,k in ipairs(keys) do out=out..k..'='..value(o.last[k])..';' end
            end
            return out
        end
    "#).exec().unwrap();
    lua.load(source).exec().unwrap();
    lua
}

#[test]
fn plate_motion_updates_only_the_parent_anchor_when_appearance_is_unchanged() {
    let lua = fixture(include_str!("planner_nameplates.lua"));
    lua.load(
        r#"
        PullFictionPlates_Update(UNITS,1,false)
        COUNTS={}
        for i=1,25 do UNITS[1].x=100+i;PullFictionPlates_Update(UNITS,1,false) end
        assert((COUNTS.SetPoint or 0)==25)
        assert((COUNTS.ClearAllPoints or 0)==25)
        assert((COUNTS.SetWidth or 0)==0)
        assert((COUNTS.SetHeight or 0)==0)
        assert((COUNTS.SetFont or 0)==0)
        assert((COUNTS.SetText or 0)==0)
        assert((COUNTS.SetTexture or 0)==0)
        assert((COUNTS.SetVertexColor or 0)==0)
        local f=PullFictionPlates[UNITS[1].key]
        assert(f.last.SetPoint[4]==125 and f.last.SetPoint[5]==-200)
    "#,
    )
    .exec()
    .unwrap();
}

#[test]
fn plates_keep_health_cast_icons_visibility_and_layout_current() {
    let lua = fixture(include_str!("planner_nameplates.lua"));
    lua.load(
        r#"
        PullFictionPlates_Update(UNITS,1,false)
        local d=UNITS[1];local f=PullFictionPlates[d.key]
        d.health=.5;d.hptext='50%';d.name='Changed';d.cast.progress=.5;d.cast.remaining='1.0'
        d.auras[1].stack=3;d.auras[1].icon='changed.blp'
        PullFictionPlates_Update(UNITS,1,true)
        assert(f.fill.last.SetWidth[1]==70)
        assert(f.name.last.SetText[1]=='Changed' and f.hp.last.SetText[1]=='50%')
        assert(f.castfill.last.SetWidth[1]==70 and f.casttime.last.SetText[1]=='1.0')
        assert(f.icons[1].tex.last.SetTexture[1]=='changed.blp')
        assert(f.icons[1].stack.last.SetText[1]=='3')
        assert(f.last.EnableMouse[1]==false)
        PullFictionPlates_Update(UNITS,.5,false)
        assert(f.last.SetWidth[1]==70 and f.name.last.SetFont[2]==5.5)
        assert(f.fill.last.SetWidth[1]==35)
        d.name_only=true;d.cast=nil;d.auras={}
        PullFictionPlates_Update(UNITS,.5,false)
        assert(not f.fill.shown and not f.castfill.shown and not f.icons[1].shown)
        d.name_only=false;d.health=0
        PullFictionPlates_Update(UNITS,.5,false)
        assert(not f.fill.shown and f.edge.shown)
        PullFictionPlates_Update({},.5,false);assert(not f.shown)
        PullFictionPlates_Update(UNITS,.5,false);assert(f.shown)
    "#,
    )
    .exec()
    .unwrap();
}

#[test]
fn failed_plate_font_and_texture_loads_retry_without_argument_changes() {
    let lua = fixture(include_str!("planner_nameplates.lua"));
    lua.load(
        r#"
        FAIL_FONTS=true;FAIL_TEXTURES=true
        PullFictionPlates_Update(UNITS,1,false)
        FAIL_FONTS=false;FAIL_TEXTURES=false;COUNTS={}
        PullFictionPlates_Update(UNITS,1,false)
        assert((COUNTS.SetFont or 0)>0 and (COUNTS.SetTexture or 0)>0)
        COUNTS={};PullFictionPlates_Update(UNITS,1,false)
        assert((COUNTS.SetFont or 0)==0 and (COUNTS.SetTexture or 0)==0)
    "#,
    )
    .exec()
    .unwrap();
}
