//! Regression through the production ECS simulator, without ReplayStep or a GPU.
use super::*;
use bevy::ecs::system::RunSystemOnce;
use std::time::Duration;

fn fixture() -> App {
    let mut app = App::new();
    app.init_resource::<Time>()
        .init_resource::<ParticleTuning>()
        .init_resource::<Assets<Image>>()
        .init_resource::<EffectQuads>()
        .init_resource::<crate::view::ViewDistance>()
        .init_resource::<crate::wmo_portal::ExteriorWindows>()
        .init_resource::<crate::wmo_portal::CameraInteriorClaim>()
        .init_resource::<crate::liquid::WaterIndex>()
        .init_resource::<crate::liquid::Underwater>()
        .init_resource::<avian3d::collider_tree::ColliderTrees>();
    app.world_mut().spawn((
        WorldCamera,
        Camera::default(),
        Projection::default(),
        Transform::IDENTITY,
        GlobalTransform::IDENTITY,
        Frustum::default(),
    ));
    app
}

fn spawn(app: &mut App, burst: bool) -> (Entity, Entity) {
    let owner = app
        .world_mut()
        .spawn((
            GlobalTransform::from_translation(Vec3::new(0., 0., -5.)),
            InheritedVisibility::VISIBLE,
        ))
        .id();
    let texture = app
        .world_mut()
        .resource_mut::<Assets<Image>>()
        .add(Image::default());
    let mut def = crate::testing::plain_particle_def();
    def.position = [0.; 3];
    def.emission_rate_variation = 0.5;
    if burst {
        def.flags |= 0x8000;
    }
    let model = benilla_assets::ModelEmitter {
        def,
        texture: Some(texture),
        extra_textures: None,
        bone_pivot: [0.; 3],
        billboard: None,
        recursion: None,
        geometry: None,
        owner_reach: 0.,
        water_bound: (Vec3::ZERO, 0.),
        idle_seq: 0,
    };
    let emitter = app
        .world_mut()
        .run_system_once(move |mut commands: Commands| {
            super::super::spawn_emitter(
                &mut commands,
                &model,
                Transform::IDENTITY,
                super::super::EmitterFrames {
                    owner: Some((owner, [0.; 3])),
                    anchor: Some(owner),
                    on_owner_loss: OwnerLoss::Free,
                    ..default()
                },
                super::super::EmitClock::Pinned,
            )
        })
        .unwrap()
        .unwrap();
    {
        let mut pool = app.world_mut().get_mut::<ParticleEmitter>(emitter).unwrap();
        let texture = pool.texture.clone();
        let mut child_def = crate::testing::plain_particle_def();
        child_def.emission_rate_variation = 0.5;
        pool.children.push(ChildEmitter {
            extra_textures: None,
            def: child_def,
            texture,
            particles: Vec::new(),
            accumulator: 0.,
            gate_prev: false,
            rng: 7,
        });
    }
    (owner, emitter)
}

fn frame(app: &mut App, seconds: f32) {
    app.world_mut()
        .resource_mut::<Time>()
        .advance_by(Duration::from_secs_f32(seconds));
    app.world_mut()
        .run_system_once(super::super::buffer::begin_effect_frame)
        .unwrap();
    app.world_mut().run_system_once(simulate_particles).unwrap();
}

fn state(app: &App, entity: Entity) -> Vec<u32> {
    let e = app.world().get::<ParticleEmitter>(entity).unwrap();
    let mut out = vec![
        e.age.to_bits(),
        e.accumulator.to_bits(),
        e.rng,
        e.gate_prev as u32,
        e.inherit_accum.to_bits(),
        e.particles.len() as u32,
    ];
    out.extend(e.inherit_vel.to_array().map(f32::to_bits));
    out.push(e.emitter_prev.is_some() as u32);
    out.extend(
        e.emitter_prev
            .unwrap_or(Vec3::ZERO)
            .to_array()
            .map(f32::to_bits),
    );
    for child in &e.children {
        out.extend([
            child.rng,
            child.accumulator.to_bits(),
            child.gate_prev as u32,
            child.particles.len() as u32,
        ]);
    }
    for p in e
        .particles
        .iter()
        .chain(e.children.iter().flat_map(|child| &child.particles))
    {
        out.extend(p.pos.to_array().map(f32::to_bits));
        out.extend(p.vel.to_array().map(f32::to_bits));
        out.extend([p.age.to_bits(), p.life.to_bits(), p.phase, p.fresh as u32]);
        out.extend(p.quat.to_array().map(f32::to_bits));
    }
    out
}

#[test]
fn zero_delta_redraws_live_quads_without_simulating_and_retires_replaced_owners() {
    let mut app = fixture();
    let (owner, emitter) = spawn(&mut app, false);
    frame(&mut app, 0.1);
    frame(&mut app, 0.1);
    assert!(app.world().get::<ParticleEmitter>(emitter).unwrap().live() > 0);
    let vertices =
        bytemuck::cast_slice::<EffectVertex, u8>(&app.world().resource::<EffectQuads>().verts)
            .to_vec();
    assert!(
        !vertices.is_empty(),
        "the advancing production frame drew a live cloud"
    );
    let saved = state(&app, emitter);
    for _ in 0..2 {
        frame(&mut app, 0.);
        assert_eq!(
            bytemuck::cast_slice::<EffectVertex, u8>(&app.world().resource::<EffectQuads>().verts),
            vertices,
            "the cleared production stream must redraw the frozen pool"
        );
        assert_eq!(
            state(&app, emitter),
            saved,
            "zero delta must not integrate, emit, age or consume RNG"
        );
    }
    // Geometry particles are world roots held by the pool; cleanup must retire these too.
    let geometry = app.world_mut().spawn_empty().id();
    {
        let mut pool = app.world_mut().get_mut::<ParticleEmitter>(emitter).unwrap();
        pool.model_instances
            .push(super::super::model::ModelInstance {
                meshes: vec![(geometry, Handle::default())],
            });
        pool.set_frozen(true);
    }
    app.world_mut().despawn(owner);
    let (_, replacement) = spawn(&mut app, true);
    let unborn = state(&app, replacement);
    frame(&mut app, 0.);
    assert!(
        app.world().get_entity(emitter).is_err(),
        "a lost Free owner retires even a scene-frozen pool"
    );
    assert!(
        app.world().get_entity(geometry).is_err(),
        "its geometry-particle instances retire with it"
    );
    assert_eq!(
        state(&app, replacement),
        unborn,
        "a frozen replacement must not trigger a burst"
    );
    assert!(
        app.world().resource::<EffectQuads>().verts.is_empty(),
        "no old fixture quads leak into the replacement"
    );
}
