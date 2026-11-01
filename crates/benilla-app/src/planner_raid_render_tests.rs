//! Exercise the production Lua's visible state and calls across changing replay payloads.
use benilla_ui::mlua::Lua;

#[test]
fn raid_widgets_skip_unchanged_mutations_but_follow_data_and_layout_changes() {
    let lua = Lua::new();
    lua.load(
        r#"
        COUNTS={}
        local function widget()
            local o={last={}}
            return setmetatable(o,{__index=function(self,k)
                if string.find(k,'^Create') then return function() return widget() end end
                if string.find(k,'^Set') or string.find(k,'^Clear') or string.find(k,'^Register')
                    or string.find(k,'^Enable') or k=='Show' or k=='Hide' then
                    local f=function(self,...) COUNTS[k]=(COUNTS[k] or 0)+1;
                        if k=='SetFont' and FAIL_FONTS then return nil end
                        self.last[k]=arg;return 1 end
                    rawset(self,k,f);return f
                end
            end})
        end
        WorldFrame=widget()
        function CreateFrame() return widget() end
    "#,
    )
    .exec()
    .unwrap();
    lua.load(include_str!("planner_raid.lua")).exec().unwrap();
    lua.load(
        r#"
        UNITS={{guid='1',name='First',class=1,hp=100,max=100,known=true,
            power=50,maxpower=100,powertype=0,powerknown=true,selected=false,
            cast={name='Cast',progress=.25},auras={{name='Aura',icon='A',stack=1,debuff=true}}},
            {guid='2',name='Second',class=5,hp=100,max=100,known=true,
            power=100,maxpower=100,powertype=0,powerknown=true,selected=false,auras={}}}
        PullFictionRaid_Update(UNITS,true,1,5,1)
        assert((COUNTS.ClearAllPoints or 0)>0)
        COUNTS={}
        -- Mutate the same row table, as the persistent native serialization path does.
        UNITS[1].hp=99
        PullFictionRaid_Update(UNITS,true,1,5,1)
        assert((COUNTS.ClearAllPoints or 0)==0,'unchanged geometry must not re-anchor')
        assert((COUNTS.SetFont or 0)==0,'unchanged fonts must not reshape labels')
        assert((COUNTS.SetText or 0)==0,'unchanged text must not cross the host bridge')
        assert(PullFictionRaid[1].health.last.SetValue[1]==99)
        COUNTS={}
        UNITS[1].cast.progress=.5
        UNITS[1].name='Renamed'
        UNITS[1].auras[1].stack=2
        PullFictionRaid_Update(UNITS,true,1,5,1)
        assert(COUNTS.ClearAllPoints==1,'only cast width changed')
        assert(PullFictionRaid[1].castfill.last.SetWidth[1]==83*.5)
        assert(PullFictionRaid[1].name.last.SetText[1]=='Renamed')
        assert(PullFictionRaid[1].icons[1].stack.last.SetText[1]=='2')
        assert(PullFictionRaid[1].icons[1].aura==UNITS[1].auras[1])
        COUNTS={}
        PullFictionRaid_Update(UNITS,true,1,1,.5)
        assert((COUNTS.ClearAllPoints or 0)>1,'scale/grid change must relayout')
        assert((COUNTS.SetFont or 0)>0,'scale change must resize fonts')
        assert(PullFictionRaid[2].last.SetPoint[4]==12+91*.5)
        FAIL_FONTS=true
        PullFictionRaid_Update(UNITS,true,1,1,.75)
        COUNTS={};FAIL_FONTS=false
        PullFictionRaid_Update(UNITS,true,1,1,.75)
        assert((COUNTS.SetFont or 0)>0,'a failed font load must retry with identical arguments')
        COUNTS={}
        PullFictionRaid_Update(UNITS,true,1,1,.75)
        assert((COUNTS.SetFont or 0)==0,'only successful font loads are cached')
        UNITS[1].hp=0;UNITS[1].cast=nil;UNITS[1].auras={}
        PullFictionRaid_Update(UNITS,true,1,1,.5)
        assert(PullFictionRaid[1].hp.last.SetText[1]=='Dead')
        assert(PullFictionRaid[1].castfill.last.Hide~=nil)
        assert(PullFictionRaid[1].icons[1].last.Hide~=nil)
        PullFictionRaid_Update(UNITS,false,1,1,.5)
        assert(PullFictionRaid[1].last.Hide~=nil and PullFictionRaid[2].last.Hide~=nil)
    "#,
    )
    .exec()
    .unwrap();
}
