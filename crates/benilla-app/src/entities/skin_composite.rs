//! Composited body skins, one 256² atlas per look. An arriving body's first composite runs off the
//! main thread: the reference's world composite is unforced, so its section loads poll and never
//! block the frame (`0x44b430`), and it draws nothing of a unit whose first composite has not
//! finished, its ShouldRender answering `0x477860(cc, 0)`'s result (`0x607e7c`). Only the forced
//! callers wait on their loads (`0x44ad50`): the glue model (`0x470c59`, `0x471308`, `0x4731b6`),
//! the dressing room (`0x504485`), `PlayerModel`'s `SetUnit` (`0x5059be`) and world entry
//! (`0x49091e`). Here the forced lane ([`SkinComposites::force`]) composites on the calling thread.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use benilla_assets::{repeat_texture_authored, LockRecover, SpatialCache};
use benilla_formats::{blp_bytes_to_mip_chain, BlpMipChain, Chain, CharSections, CompositePlan};
use bevy::prelude::*;
use bevy::tasks::{block_on, futures_lite::future, AsyncComputeTaskPool, Task};

/// The `CharSections` skin lookup and the chain its textures read from; without it a player's body
/// skin stays untextured.
#[derive(Resource)]
pub(super) struct SkinSections {
    pub(super) tables: CharSections,
    chain: Arc<Mutex<Chain>>,
}

impl SkinSections {
    pub(super) fn new(tables: CharSections, chain: Arc<Mutex<Chain>>) -> Self {
        Self { tables, chain }
    }
}

/// What decides a composited body skin: race and sex pick the `CharSections` rows, the dials pick
/// the variations, and `equip` holds the worn armour display ids by body slot − 2.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) struct SkinKey {
    pub(super) race: u8,
    pub(super) sex: u8,
    pub(super) skin: u8,
    pub(super) face: u8,
    pub(super) facial_hair: u8,
    pub(super) hair_style: u8,
    pub(super) hair_color: u8,
    pub(super) equip: [u32; 8],
    /// The guild emblem: two guilds' members wear one tabard display but must not share an atlas.
    pub(super) emblem: Option<benilla_formats::GuildEmblem>,
    /// The tabard designer's preview: the emblem paints over an empty tabard slot.
    pub(super) tabard_preview: bool,
}

/// Where a body's atlas stands.
#[derive(Debug, PartialEq)]
pub(super) enum BodyAtlas {
    /// Ready to bind; `None` for a look with no atlas (no base skin row, or art that never read).
    Ready(Option<Handle<Image>>),
    /// Its composite is running or its browser-local source still needs preparation.
    Pending,
}

/// A composite's whole work, run where it lands: reads, decodes and blits.
type Work = Box<dyn FnOnce() -> CompositeResult + Send>;

enum CompositeResult {
    Complete(Option<BlpMipChain>),
    /// The browser-local source has not prepared this file yet. Keep the body pending and
    /// check its cheap readiness lookup before doing any more reads or decoding.
    Unprepared(TextureReadiness),
}

pub(super) struct TextureReadiness {
    pub(super) path: String,
    pub(super) ready: Box<dyn Fn() -> bool + Send + Sync>,
}

/// Composited body skins by look, so every body wearing a look shares one atlas, and the
/// composites still running.
#[derive(Resource, Default)]
pub(super) struct SkinComposites {
    /// Finished atlases, swept by distance ([`benilla_world::art_scope`]); `None` for a look with
    /// no atlas, so it is never retried.
    pub(super) done: SpatialCache<SkinKey, Option<Handle<Image>>>,
    /// Composites on the async compute pool, one per look however many bodies wait on it.
    running: HashMap<SkinKey, Task<CompositeResult>>,
    pub(super) unprepared: HashMap<SkinKey, TextureReadiness>,
}

impl SkinComposites {
    /// A cached terminal answer or a preparation wait. No source tables are needed for either.
    pub(super) fn cached_atlas(&mut self, key: SkinKey) -> Option<BodyAtlas> {
        if let Some(done) = self.done.fetch(&key) {
            return Some(BodyAtlas::Ready(done));
        }
        self.unprepared
            .get(&key)
            .is_some_and(|file| !(file.ready)())
            .then_some(BodyAtlas::Pending)
    }

    /// A world body's atlas: finished, or running, its composite started here on a miss. `plan` is
    /// read only then; `None` is a look with no atlas.
    pub(super) fn request(
        &mut self,
        key: SkinKey,
        sections: &SkinSections,
        plan: impl FnOnce() -> Option<CompositePlan>,
    ) -> BodyAtlas {
        self.request_with(key, || plan().map(|p| work(p, sections.chain.clone())))
    }

    /// [`Self::request`] over any work, so the lane is testable without the install.
    fn request_with(&mut self, key: SkinKey, work: impl FnOnce() -> Option<Work>) -> BodyAtlas {
        if let Some(done) = self.done.fetch(&key) {
            return BodyAtlas::Ready(done);
        }
        if self.running.contains_key(&key) {
            return BodyAtlas::Pending;
        }
        if self
            .unprepared
            .get(&key)
            .is_some_and(|file| !(file.ready)())
        {
            return BodyAtlas::Pending;
        }
        self.unprepared.remove(&key);
        let Some(work) = work() else {
            self.done.insert(key, None);
            return BodyAtlas::Ready(None);
        };
        self.running.insert(
            key,
            AsyncComputeTaskPool::get().spawn(async move { work() }),
        );
        BodyAtlas::Pending
    }

    /// An atlas composited on this thread on a miss, or waited for if it is already running, as
    /// the reference's forced composite waits on its section loads (`0x44ad50`) and passes no
    /// admission test: the glue model's (`0x477860(cc, 1)` at `0x470c59`, `0x471308`, `0x4731b6`)
    /// and the dressing room's (`0x504485`, in `0x504470`). A re-dress of a standing body and a
    /// rig-heal rebuild come here too, so neither drops out for a frame.
    pub(super) fn force(
        &mut self,
        key: SkinKey,
        sections: &SkinSections,
        plan: impl FnOnce() -> Option<CompositePlan>,
        images: &mut Assets<Image>,
    ) -> BodyAtlas {
        self.force_with(
            key,
            || plan().map(|p| work(p, sections.chain.clone())),
            images,
        )
    }

    /// [`Self::force`] over any work, so the lane is testable without the install.
    fn force_with(
        &mut self,
        key: SkinKey,
        work: impl FnOnce() -> Option<Work>,
        images: &mut Assets<Image>,
    ) -> BodyAtlas {
        if let Some(cached) = self.cached_atlas(key) {
            return cached;
        }
        self.unprepared.remove(&key);
        let atlas = match self.running.remove(&key) {
            Some(task) => block_on(task),
            None => work().map_or(CompositeResult::Complete(None), |w| w()),
        };
        let atlas = self.install(key, atlas, images);
        if self.unprepared.contains_key(&key) {
            BodyAtlas::Pending
        } else {
            BodyAtlas::Ready(atlas)
        }
    }

    /// Move every finished composite into [`Self::done`]; how many landed.
    pub(super) fn land(&mut self, images: &mut Assets<Image>) -> usize {
        let mut finished = Vec::new();
        self.running
            .retain(|key, task| match block_on(future::poll_once(task)) {
                Some(atlas) => {
                    finished.push((*key, atlas));
                    false
                }
                None => true,
            });
        let landed = finished.len();
        for (key, atlas) in finished {
            self.install(key, atlas, images);
        }
        landed
    }

    /// Upload one atlas and cache it by look.
    fn install(
        &mut self,
        key: SkinKey,
        result: CompositeResult,
        images: &mut Assets<Image>,
    ) -> Option<Handle<Image>> {
        let atlas = match result {
            CompositeResult::Unprepared(file) => {
                warn!(
                    "body skin waits for prepared texture '{}' ({key:?})",
                    file.path
                );
                self.unprepared.insert(key, file);
                return None;
            }
            CompositeResult::Complete(atlas) => atlas,
        };
        // Through the upload gate like every texture: a no-op on this RGBA8 composite, but it
        // keeps the format and the bytes in agreement.
        let handle = atlas.map(|a| {
            images.add(repeat_texture_authored(
                benilla_assets::for_upload(a),
                (true, true),
            ))
        });
        self.done.insert(key, handle.clone());
        handle
    }

    /// How many composites are running.
    #[cfg(test)]
    pub(super) fn running(&self) -> usize {
        self.running.len()
    }

    /// Drop every atlas, running composite and preparation wait: the map-change teardown.
    pub(super) fn clear(&mut self) {
        self.done.clear();
        self.running.clear();
        self.unprepared.clear();
    }
}

/// A plan's work over the shared chain, which each read locks for its archive lookup alone.
fn work(plan: CompositePlan, chain: Arc<Mutex<Chain>>) -> Work {
    Box::new(move || {
        let mut unprepared = None;
        let result = plan.run(|path| {
            let result = read_texture(&chain, path);
            if result.as_ref().is_err_and(|error| source_unprepared(error)) {
                unprepared = Some(path.to_owned());
            }
            result
        });
        finish_work(result, || {
            let path = unprepared.expect("an unprepared read names its texture");
            let probe_path = path.clone();
            TextureReadiness {
                path,
                ready: Box::new(move || texture_prepared(&probe_path)),
            }
        })
    })
}

fn source_unprepared(error: &anyhow::Error) -> bool {
    #[cfg(any(target_arch = "wasm32", test))]
    {
        error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
        })
    }
    #[cfg(not(any(target_arch = "wasm32", test)))]
    {
        let _ = error;
        false
    }
}

/// Preserve the local provider's typed readiness error through the compositor's context.
/// Missing files, invalid BLPs and unsupported appearances remain terminal cache entries.
fn finish_work(
    result: anyhow::Result<BlpMipChain>,
    readiness: impl FnOnce() -> TextureReadiness,
) -> CompositeResult {
    match result {
        Ok(atlas) => CompositeResult::Complete(Some(atlas)),
        Err(error) if source_unprepared(&error) => CompositeResult::Unprepared(readiness()),
        Err(error) => {
            warn!("body skin composite failed: {error:#}");
            CompositeResult::Complete(None)
        }
    }
}

fn texture_prepared(_path: &str) -> bool {
    #[cfg(target_arch = "wasm32")]
    if benilla_formats::browser_local::active() {
        return !matches!(
            benilla_formats::browser_local::contains_sync(_path),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        );
    }
    true
}

/// Read and decode one BLP off `chain`, locked only to find its archive.
fn read_texture(chain: &Mutex<Chain>, path: &str) -> anyhow::Result<BlpMipChain> {
    let name = path.replace('/', "\\");
    #[cfg(not(target_arch = "wasm32"))]
    let bytes = {
        let archive = chain.lock_recover().archive_for(&name)?;
        archive
            .read_file(&name)
            .with_context(|| format!("reading texture '{name}'"))?
    };
    // wasm32: the chain has no archives, only the web host's Data URLs (`benilla_formats::web`).
    #[cfg(target_arch = "wasm32")]
    let bytes = chain
        .lock_recover()
        .read(&name)
        .with_context(|| format!("reading texture '{name}'"))?;
    blp_bytes_to_mip_chain(&bytes).with_context(|| format!("decoding texture '{name}'"))
}

/// Land every finished composite before this frame's bodies ask for theirs.
pub(super) fn land_skin_composites(
    mut composites: ResMut<SkinComposites>,
    mut images: ResMut<Assets<Image>>,
) {
    composites.land(&mut images);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn key(race: u8) -> SkinKey {
        SkinKey {
            race,
            sex: 0,
            skin: 0,
            face: 0,
            facial_hair: 0,
            hair_style: 0,
            hair_color: 0,
            equip: [0; 8],
            emblem: None,
            tabard_preview: false,
        }
    }

    /// A 1×1 atlas.
    fn atlas() -> BlpMipChain {
        BlpMipChain {
            width: 1,
            height: 1,
            texels: benilla_formats::BlpTexels::Rgba8Unorm,
            mips: vec![vec![255; 4]],
        }
    }

    /// Work that finishes when the test says so, and counts how many times it ran. It gives up
    /// after two seconds, so work run inline on the test's thread fails the test, never hangs it.
    fn gated(ran: &Arc<std::sync::atomic::AtomicUsize>) -> (mpsc::Sender<()>, Work) {
        let (tx, rx) = mpsc::channel::<()>();
        let ran = ran.clone();
        let work: Work = Box::new(move || {
            ran.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let finished = rx.recv_timeout(std::time::Duration::from_secs(2)).is_ok();
            CompositeResult::Complete(finished.then(atlas))
        });
        (tx, work)
    }

    /// Land until `key` is done, or give up after two seconds.
    fn land_until(c: &mut SkinComposites, images: &mut Assets<Image>, key: SkinKey) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while c.running.contains_key(&key) && std::time::Instant::now() < deadline {
            c.land(images);
            std::thread::yield_now();
        }
    }

    /// A look's composite runs once off the main thread however many bodies ask, and every body
    /// gets the one atlas once it lands.
    #[test]
    fn a_look_composites_once_off_the_main_thread() {
        AsyncComputeTaskPool::get_or_init(bevy::tasks::TaskPool::new);
        let mut images = Assets::<Image>::default();
        let mut c = SkinComposites::default();
        let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (tx, w) = gated(&ran);
        let mut w = Some(w);

        assert_eq!(c.request_with(key(1), || w.take()), BodyAtlas::Pending);
        // A second body of the same look waits on the same composite; its work is never built.
        assert_eq!(
            c.request_with(key(1), || panic!(
                "a running look starts no second composite"
            )),
            BodyAtlas::Pending
        );
        assert_eq!(c.running(), 1);
        assert_eq!(
            c.land(&mut images),
            0,
            "nothing lands before the work finishes"
        );

        tx.send(()).unwrap();
        land_until(&mut c, &mut images, key(1));
        let BodyAtlas::Ready(Some(first)) = c.request_with(key(1), || None) else {
            panic!("the landed atlas is ready");
        };
        assert_eq!(
            c.request_with(key(1), || None),
            BodyAtlas::Ready(Some(first))
        );
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(c.running(), 0);
    }

    /// A forced composite of a look already running waits for that composite rather than starting
    /// a second, and the atlas is the one every later request gets.
    #[test]
    fn a_forced_composite_takes_over_the_running_one() {
        AsyncComputeTaskPool::get_or_init(bevy::tasks::TaskPool::new);
        let mut images = Assets::<Image>::default();
        let mut c = SkinComposites::default();
        let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (tx, w) = gated(&ran);
        let mut w = Some(w);
        assert_eq!(c.request_with(key(3), || w.take()), BodyAtlas::Pending);
        tx.send(()).unwrap();
        let forced = c.force_with(
            key(3),
            || panic!("a running look starts no second composite"),
            &mut images,
        );
        assert!(
            matches!(forced, BodyAtlas::Ready(Some(_))),
            "the running composite's atlas"
        );
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(c.running(), 0);
        assert_eq!(c.request_with(key(3), || None), forced);
    }

    /// A look with no atlas is ready at once, as `None`, and never retried.
    #[test]
    fn a_look_without_an_atlas_never_waits() {
        let mut c = SkinComposites::default();
        assert_eq!(c.request_with(key(9), || None), BodyAtlas::Ready(None));
        assert_eq!(
            c.request_with(key(9), || panic!("a look with no atlas is never retried")),
            BodyAtlas::Ready(None)
        );
        assert_eq!(c.running(), 0);
    }

    /// Exercise the actual async request/land/upload transition with the transport's typed
    /// unprepared error, then real BLP bytes once that same source becomes ready.
    #[test]
    fn an_unprepared_texture_waits_without_recompositing_and_recovers_when_prepared() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        AsyncComputeTaskPool::get_or_init(bevy::tasks::TaskPool::new);
        let mut c = SkinComposites::default();
        let mut images = Assets::<Image>::default();
        let ready = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let make_work = || {
            let ready = ready.clone();
            let reads = reads.clone();
            Some(Box::new(move || {
                reads.fetch_add(1, Ordering::SeqCst);
                let result = if ready.load(Ordering::SeqCst) {
                    // One BGRA texel in the same BLP2 input used by prepared browser atlases.
                    let mut bytes = vec![0u8; 1176];
                    bytes[..4].copy_from_slice(b"BLP2");
                    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
                    bytes[8..12].copy_from_slice(&[3, 8, 0, 1]);
                    bytes[12..16].copy_from_slice(&1u32.to_le_bytes());
                    bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
                    bytes[20..24].copy_from_slice(&1172u32.to_le_bytes());
                    bytes[84..88].copy_from_slice(&4u32.to_le_bytes());
                    bytes[1172..].copy_from_slice(&[30, 20, 10, 255]);
                    blp_bytes_to_mip_chain(&bytes)
                } else {
                    Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "not prepared").into())
                }
                .context("reading base skin 'prepared-body.blp'");
                finish_work(result, || TextureReadiness {
                    path: "prepared-body.blp".into(),
                    ready: Box::new(move || ready.load(Ordering::SeqCst)),
                })
            }) as Work)
        };
        assert_eq!(c.request_with(key(1), make_work), BodyAtlas::Pending);
        land_until(&mut c, &mut images, key(1));
        assert!(
            c.done.is_empty(),
            "unprepared is not a permanent missing atlas"
        );
        assert_eq!(c.unprepared.len(), 1);
        for _ in 0..100 {
            assert_eq!(
                c.request_with(key(1), || panic!("no new read before readiness")),
                BodyAtlas::Pending
            );
        }
        assert_eq!(
            c.force_with(
                key(1),
                || panic!("forced callers also respect readiness"),
                &mut images
            ),
            BodyAtlas::Pending
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        ready.store(true, Ordering::SeqCst);
        assert_eq!(c.request_with(key(1), make_work), BodyAtlas::Pending);
        land_until(&mut c, &mut images, key(1));
        let BodyAtlas::Ready(Some(handle)) =
            c.request_with(key(1), || panic!("reuse uploaded atlas"))
        else {
            panic!("prepared body uploads and becomes ready");
        };
        assert_eq!(
            images.get(&handle).unwrap().data.as_deref(),
            Some([10, 20, 30, 255].as_slice())
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert!(c.unprepared.is_empty());
    }

    #[test]
    fn missing_or_corrupt_textures_stay_terminal_without_readiness_probes() {
        AsyncComputeTaskPool::get_or_init(bevy::tasks::TaskPool::new);
        let mut c = SkinComposites::default();
        let mut images = Assets::<Image>::default();
        let errors = [
            anyhow::Error::from(std::io::Error::new(std::io::ErrorKind::NotFound, "absent")),
            blp_bytes_to_mip_chain(b"corrupt BLP").unwrap_err(),
        ];
        for (i, error) in errors.into_iter().enumerate() {
            let key = key(i as u8 + 1);
            let work: Work = Box::new(move || {
                finish_work(Err(error).context("base skin"), || {
                    panic!("permanent failures do not probe readiness")
                })
            });
            assert_eq!(c.request_with(key, || Some(work)), BodyAtlas::Pending);
            land_until(&mut c, &mut images, key);
            for _ in 0..100 {
                assert_eq!(
                    c.request_with(key, || panic!("permanent failures never retry")),
                    BodyAtlas::Ready(None)
                );
            }
        }
        assert!(c.unprepared.is_empty());
    }

    #[test]
    fn a_forced_unprepared_atlas_can_recover_and_teardown_drops_preparation_waits() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let mut c = SkinComposites::default();
        let mut images = Assets::<Image>::default();
        let ready = Arc::new(AtomicBool::new(false));
        let probe = ready.clone();
        let work: Work = Box::new(move || {
            finish_work(
                Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "not prepared").into()),
                || TextureReadiness {
                    path: "forced-body.blp".into(),
                    ready: Box::new(move || probe.load(Ordering::SeqCst)),
                },
            )
        });
        assert_eq!(
            c.force_with(key(1), || Some(work), &mut images),
            BodyAtlas::Pending
        );
        assert!(c.done.is_empty());
        ready.store(true, Ordering::SeqCst);
        assert!(matches!(
            c.force_with(
                key(1),
                || Some(Box::new(|| CompositeResult::Complete(Some(atlas())))),
                &mut images
            ),
            BodyAtlas::Ready(Some(_))
        ));
        assert!(c.unprepared.is_empty());

        c.unprepared.insert(
            key(2),
            TextureReadiness {
                path: "waiting-body.blp".into(),
                ready: Box::new(|| false),
            },
        );
        c.clear();
        assert!(c.unprepared.is_empty());
        assert!(c.done.is_empty());
    }

    /// The map-change teardown drops running composites with the cache: a body still waiting
    /// starts its composite again.
    #[test]
    fn a_teardown_drops_the_running_composites() {
        AsyncComputeTaskPool::get_or_init(bevy::tasks::TaskPool::new);
        let mut c = SkinComposites::default();
        let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_tx, w) = gated(&ran);
        let mut w = Some(w);
        assert_eq!(c.request_with(key(2), || w.take()), BodyAtlas::Pending);
        c.clear();
        assert_eq!(c.running(), 0);
        let (_tx2, w2) = gated(&ran);
        let mut w2 = Some(w2);
        assert_eq!(c.request_with(key(2), || w2.take()), BodyAtlas::Pending);
        assert!(
            w2.is_none(),
            "a body still waiting starts its composite again"
        );
    }
}
