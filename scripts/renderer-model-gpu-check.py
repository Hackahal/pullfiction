#!/usr/bin/env python3
"""Check production packed M2 combiner and UV helpers on a native GPU.

Reuses the effect checker's source extraction and native dependency infrastructure.
Never invokes Cargo, opens a client install, or downloads data. Requires already-built
native wgpu/futures-lite rlibs; use --deps-dir or explicit rlib paths when needed.
This checks exact current WGSL helper math against independent analytical constants.
It does not validate complete shader bindings, model appearance, browser execution,
texture decoding, actual lighting/fog, or official-client parity.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
INFRA = Path(__file__).with_name('renderer-effects-gpu-check.py')
SPEC = importlib.util.spec_from_file_location('renderer_gpu_infrastructure', INFRA)
GPU = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GPU)
GPU_READBACKS = 45
PROOF = ('Synthetic native GPU execution/readback of exact production packed M2 combiner, '
         'specular/UV, WMO material and terrain MCCV helper functions. Does not validate complete shader bindings, '
         'whole-model appearance, browser execution, texture decoding, actual lighting/fog, '
         'or official-client parity. The unused-third case checks helper sample arity; '
         'native parser tests separately verify real descriptor selection.')

COMPUTE_CASES = '''
@group(0) @binding(0) var<storage, read_write> output: array<vec4<f32>, 45>;
@group(0) @binding(1) var<storage, read> authored_bindings: array<vec4<f32>, 6>;
@compute @workgroup_size(1) fn main() {
    let d = vec4<f32>(0.8, 0.6, 0.4, 0.7);
    let t0 = authored_bindings[0]; let t1 = authored_bindings[1];
    for (var i = 0u; i < 10u; i += 1u) {
        output[i] = modern_two_stage_rgba(8u + i, d, t0, t1);
    }
    let uv0 = model_uv_transform(vec2<f32>(0.25, 0.75), vec2<f32>(0.1, -0.2), vec4<f32>(0.0));
    let uv1 = model_uv_transform(vec2<f32>(0.8, 0.2), vec2<f32>(0.0, 0.1), vec4<f32>(0.0, 0.0, 0.2, -0.3));
    output[10] = vec4<f32>(uv0, uv1);
    let hdr = modern_two_stage_rgba(8u, vec4<f32>(1.0),
        vec4<f32>(0.9, 0.9, 0.9, 0.6), vec4<f32>(0.8, 0.8, 0.8, 0.1));
    output[11] = vec4<f32>(hdr.rgb * 0.25, hdr.a * 0.5);
    output[12] = vec4<f32>(model_uv_transform(vec2<f32>(1.0, 0.5), vec2<f32>(0.0),
        vec4<f32>(-1.0, 1.0, 0.0, 0.0)), 0.0, 1.0);
    // Two declared triples have identical sampled stages and different unused third values.
    // This is helper arity, not an assertion about the complete renderer's binding selection.
    output[13] = modern_two_stage_rgba(9u, d, authored_bindings[0], authored_bindings[1])
               - modern_two_stage_rgba(9u, d, authored_bindings[3], authored_bindings[4]);
    output[14] = authored_bindings[2] - authored_bindings[5];
    let add = modern_two_stage_rgba(11u, d, t0, t1);
    output[15] = vec4<f32>(add.rgb * 0.25 + modern_two_stage_specular(11u, t1), add.a);
    let add_alpha = modern_two_stage_rgba(14u, d, t0, t1);
    output[16] = vec4<f32>(add_alpha.rgb * 0.25 + modern_two_stage_specular(14u, t1), add_alpha.a);
    let lit_base = vec3<f32>(0.4, 0.35, 0.05);
    output[17] = vec4<f32>(stage1_rgb(6u, lit_base, vec4<f32>(0.8, 0.7, 0.1, 0.5), 0.8),
        stage_alpha(6u, 0.8, 0.5));
    output[18] = vec4<f32>(stage1_rgb(6u, lit_base, vec4<f32>(0.8, 0.7, 0.1, 0.0), 0.8),
        stage_alpha(6u, 0.8, 0.0));
    output[19] = vec4<f32>(wmo_reflection_uv(vec3<f32>(0.6, 0.0, -0.8), vec3<f32>(0.0, 0.0, 1.0)), 0.0, 1.0);
    output[20] = vec4<f32>(wmo_env_rgb(vec3<f32>(0.2, 0.3, 0.4), vec3<f32>(0.8, 0.6, 0.4), 0.25), wmo_output_alpha(3u, 0.25));
    output[21] = vec4<f32>(wmo_specular(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, 1.0),
        vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.8, 0.4, 0.2), 0.5), wmo_output_alpha(1u, 0.5));
    output[22] = vec4<f32>(wmo_specular(vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(0.0, 0.0, 1.0),
        vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.8, 0.4, 0.2), 0.5), wmo_output_alpha(4u, 0.2));
    output[23] = vec4<f32>(wmo_output_alpha(0u, 0.2), wmo_output_alpha(4u, 0.2),
        wmo_output_alpha(21u, 0.2), wmo_output_alpha(1u, 0.2));
    output[24] = vec4<f32>(wmo_env_rgb(vec3<f32>(0.2, 0.3, 0.4), vec3<f32>(0.0), 0.8), wmo_output_alpha(3u, 0.8) * 0.25);
    output[25] = vec4<f32>(terrain_diffuse_term(vec3<f32>(0.8, 0.6, 0.4),
        vec3<f32>(2.0, 254.0 / 255.0, 0.0), vec3<f32>(0.5, 0.25, 1.0), 0.0), 1.0);
    output[26] = vec4<f32>(terrain_diffuse_term(vec3<f32>(0.8, 0.6, 0.4),
        vec3<f32>(0.0), vec3<f32>(0.5, 0.25, 1.0), 1.0), 1.0);
    output[27] = vec4<f32>(terrain_diffuse_term(vec3<f32>(0.8, 0.6, 0.4),
        vec3<f32>(1.0), vec3<f32>(0.5, 0.25, 1.0), 1.0), 1.0);
    output[28] = modern_two_stage_rgba(19u, d, t0, t1);
    for (var i = 0u; i < 3u; i += 1u) {
        let preset = 20u + i;
        let base = modern_two_stage_rgba(preset, d, t0, t1);
        output[29u + i] = vec4<f32>(base.rgb * 0.25 + modern_static_specular(preset, t0, t1, 0.3), base.a);
    }
    output[32] = modern_two_stage_rgba(23u, d, t0, t1);
    output[33] = modern_two_stage_rgba(24u, d, t0, t1);
    output[34] = modern_two_stage_rgba(19u, d, vec4<f32>(t0.rgb, 0.0), t1);
    output[35] = modern_two_stage_rgba(19u, d, vec4<f32>(t0.rgb, 1.0), t1);
    let opaque_base = modern_two_stage_rgba(20u, d, t0, t1);
    output[36] = vec4<f32>(opaque_base.rgb * 0.25 + modern_static_specular(20u, vec4<f32>(t0.rgb, 1.0), t1, 1.0), opaque_base.a);
    output[37] = vec4<f32>(opaque_base.rgb * 0.25 + modern_static_specular(20u, vec4<f32>(t0.rgb, 0.0), t1, 1.0), opaque_base.a);
    output[38] = vec4<f32>(opaque_base.rgb * 0.25 + modern_static_specular(22u, t0, t1, 0.0), opaque_base.a);
    output[39] = vec4<f32>(opaque_base.rgb * 0.25 + modern_static_specular(22u, t0, t1, 1.0), opaque_base.a);
    output[40] = modern_two_stage_rgba(24u, d, t0, vec4<f32>(t1.rgb, 0.0));
    output[41] = modern_two_stage_rgba(24u, d, t0, vec4<f32>(t1.rgb, 1.0));
    let weighted_mod = modern_two_stage_rgba(25u, d, t0, t1);
    output[42] = vec4<f32>(weighted_mod.rgb * 0.25 + modern_static_specular(25u, t0, t1, 0.3), weighted_mod.a);
    output[43] = vec4<f32>(weighted_mod.rgb * 0.25 + modern_static_specular(25u, t0, t1, 0.0), weighted_mod.a);
    output[44] = vec4<f32>(weighted_mod.rgb * 0.25 + modern_static_specular(25u, t0, t1, 1.0), weighted_mod.a);
}
'''


def generate(repo, output):
    shader = repo / 'crates/benilla-assets/src/shaders/wow_model.wgsl'
    terrain = repo / 'crates/benilla-assets/src/shaders/terrain.wgsl'
    fixture = Path(__file__).with_name('renderer-model-gpu-check-fixture.rs')
    source = shader.read_text()
    helpers = '\n\n'.join(GPU.block(source, 'fn ' + name + '(') for name in (
        'modern_two_stage_rgba', 'modern_two_stage_specular', 'modern_static_specular', 'model_uv_transform',
        'stage1_rgb', 'stage_alpha', 'wmo_reflection_uv', 'wmo_env_rgb', 'wmo_specular', 'wmo_output_alpha'))
    helpers += '\n\n' + GPU.block(terrain.read_text(), 'fn terrain_diffuse_term(')
    (output / 'packed-model-helpers.wgsl').write_text(helpers + '\n' + COMPUTE_CASES)
    harness = output / 'harness.rs'
    harness.write_text(fixture.read_text())
    return harness, [{'path': str(p), 'sha256': GPU.digest(p)} for p in (shader, terrain, fixture, INFRA)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True, help='Fresh local output directory; existing paths are refused')
    parser.add_argument('--deps-dir', type=Path)
    parser.add_argument('--rustc', default=shutil.which('rustc'))
    parser.add_argument('--wgpu-rlib', type=Path)
    parser.add_argument('--futures-lite-rlib', type=Path)
    args = parser.parse_args()
    try:
        if not args.rustc:
            raise ValueError('rustc is not on PATH; pass --rustc or use the configured Rust environment.')
        repo, output = args.repo.resolve(), args.output.resolve()
        if args.output.exists() or args.output.is_symlink():
            raise ValueError('Output already exists; select a fresh directory.')
        deps = (args.deps_dir or repo / 'target/debug/deps').resolve()
        libraries = {'wgpu': GPU.dependency(args.wgpu_rlib, deps, 'wgpu'),
                     'futures_lite': GPU.dependency(args.futures_lite_rlib, deps, 'futures_lite')}
        output.mkdir(parents=True, exist_ok=False)
        harness, sources = generate(repo, output)
        command = [args.rustc, '--edition', '2021', harness, '-L', f'dependency={deps}']
        for name, path in libraries.items():
            command.extend(['--extern', f'{name}={path}'])
        binary = output / 'gpu-check'
        GPU.run([*command, '-o', binary], output, 'compile-gpu', repo)
        log = GPU.run([binary, output / 'packed-model-helpers.wgsl'], output, 'gpu', repo)
        if log.count('PASS ') != GPU_READBACKS:
            raise ValueError(f'Expected all {GPU_READBACKS} GPU readbacks to execute.')
        report = {'schema': 1, 'status': 'passed', 'gpuReadbacks': GPU_READBACKS,
                  'proofBoundary': PROOF, 'sourceFiles': sources,
                  'generatorSHA256': GPU.digest(Path(__file__)), 'harnessSHA256': GPU.digest(harness),
                  'nativeLibraries': {name: str(path) for name, path in libraries.items()},
                  'syntheticDiffuseRGBA': [.8, .6, .4, .7],
                  'syntheticBindingsRGBA': [[.9, .7, .5, .6], [.8, .6, .4, .1], [0, 0, 0, 0],
                                            [.9, .7, .5, .6], [.8, .6, .4, .1], [1, 1, 1, 1]]}
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status': 'passed', 'gpuReadbacks': GPU_READBACKS,
                          'report': str(output / 'report.json'), 'proofBoundary': PROOF}))
    except (ValueError, OSError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
