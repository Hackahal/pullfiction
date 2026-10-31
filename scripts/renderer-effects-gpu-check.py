#!/usr/bin/env python3
"""Check current effect alpha policies and complete WGSL fragments with synthetic pixels.

Uses rustc and already-built native wgpu/futures-lite rlibs; never invokes Cargo,
opens an installed client, or downloads data. A working native GPU adapter is
required. Run after a normal native build has populated target/debug/deps, or
pass --deps-dir / explicit --wgpu-rlib and --futures-lite-rlib paths. The harness
uses current production source, synthetic uniforms and a 1x1 Unorm texture; it
does not verify whole-model appearance, browser execution, sRGB or BC decoding.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
VARIANTS = {
    'legacy-mod': {'BLEND_MOD2X'},
    'modern-mod': {'BLEND_MOD2X', 'MODERN_PARTICLE_BLEND'},
    'modern-mod2x': {'BLEND_MOD2X', 'MODERN_PARTICLE_BLEND'},
    'modern-blendadd': {'BLEND_ALPHA', 'MODERN_PARTICLE_BLEND'},
    'modern-key': {'BLEND_ALPHAKEY', 'MODERN_PARTICLE_KEY'},
    'legacy-key': {'BLEND_ALPHAKEY'},
    'legacy-mod2x': {'BLEND_MOD2X'},
    'modern-alpha': {'BLEND_ALPHA', 'MODERN_PARTICLE_BLEND'},
}
PROOF = ('Synthetic native GPU render/readback of complete production fragment variants and '
         'production blend states. Does not verify whole-model appearance, browser execution, '
         'sRGB/BC decode, lighting/fog, particle simulation, or official-client parity.')
GPU_READBACKS = 24


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def block(text, marker):
    """Extract the current Rust item; skip strings and comments while balancing braces."""
    if marker not in text:
        raise ValueError(f'Production contract changed; cannot find source item: {marker}')
    start = text.index(marker)
    first = text.index('{', start)
    depth, index = 1, first + 1
    while depth and index < len(text):
        if text.startswith('//', index):
            end = text.find('\n', index)
            index = len(text) if end < 0 else end + 1
        elif text.startswith('/*', index):
            end = text.find('*/', index + 2)
            if end < 0:
                raise ValueError('Unclosed source comment')
            index = end + 2
        elif text[index] == '"':
            index += 1
            while index < len(text) and text[index] != '"':
                index += 2 if text[index] == '\\' else 1
            index += 1
        else:
            depth += (text[index] == '{') - (text[index] == '}')
            index += 1
    if depth:
        raise ValueError(f'Cannot extract current source item: {marker}')
    return text[start:index]


def preprocess(shader, defines):
    active, lines = [True], []
    for line in shader.splitlines():
        if line.startswith('#ifdef '):
            active.append(active[-1] and line.split()[1] in defines)
        elif line.startswith('#ifndef '):
            active.append(active[-1] and line.split()[1] not in defines)
        elif line.startswith('#else'):
            active[-1] = active[-2] and not active[-1]
        elif line.startswith('#endif'):
            active.pop()
        elif line == '#import bevy_render::view::View':
            if active[-1]:
                lines.append('struct View {clip_from_world: mat4x4<f32>, view_from_world: mat4x4<f32>,'
                             'clip_from_view: mat4x4<f32>, mip_bias:f32};')
        elif line.startswith('#'):
            raise ValueError(f'New shader directive needs explicit harness support: {line}')
        elif active[-1]:
            lines.append(line)
    if len(active) != 1:
        raise ValueError('Unbalanced shader conditionals')
    lines.append('''
struct TestParams { color:vec4<f32>, uv_layers:vec4<f32>, material:vec2<f32>, padding:vec2<f32> };
@group(2) @binding(0) var<uniform> test_params: TestParams;
@vertex fn test_vertex(@builtin(vertex_index) id:u32)->VertexOutput {
    var positions=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));
    var out:VertexOutput;
    out.clip_position=vec4<f32>(positions[id],0.,1.);
    out.uv=vec2<f32>(0.5);out.color=test_params.color;out.view_z=0.;
    out.uv_layers=test_params.uv_layers;out.material=test_params.material;return out;
}''')
    return '\n'.join(lines)


def generate(repo, output):
    paths = {
        'buffer': repo / 'crates/benilla-world/src/particles/buffer.rs',
        'render': repo / 'crates/benilla-world/src/particles/render.rs',
        'formats': repo / 'crates/benilla-formats/src/particles.rs',
        'shader': repo / 'crates/benilla-world/src/shaders/wow_effect.wgsl',
        'fixture': Path(__file__).with_name('renderer-effects-gpu-check-fixture.rs'),
    }
    source = {name: path.read_text() for name, path in paths.items()}
    for name, defines in VARIANTS.items():
        (output / f'modern-alpha-{name}.wgsl').write_text(preprocess(source['shader'], defines))
    code = ('use futures_lite::future::block_on;\n'
            'use wgpu::{BlendState,BlendComponent,BlendFactor,BlendOperation};\n'
            'extern crate self as benilla_formats;\n')
    for name, marker in [('formats', 'pub enum ParticleBlend'), ('buffer', 'pub enum EffectBlend')]:
        code += '#[derive(Debug,Clone,Copy,PartialEq,Eq,Hash)]\n' + block(source[name], marker) + '\n'
    code += block(source['buffer'], 'impl From<ParticleBlend> for EffectBlend')
    code += '\nimpl EffectBlend {\n' + block(source['buffer'], 'pub fn particle(')
    code += '\n' + block(source['buffer'], 'pub fn modern_alpha_test(') + '\n}\n'
    code += '#[derive(Clone,Copy,PartialEq,Eq,Hash)]\n' + block(source['render'], 'pub struct EffectPipelineKey')
    code += '\n' + block(source['render'], 'fn effect_blend_state(')
    code += '\n#[cfg(test)] mod tests {\n'
    for name, marker in [
        ('buffer', 'modern_particle_alpha_policy_is_keyed_and_legacy_is_unchanged'),
        ('render', 'modern_particle_alpha_policy_separates_pipeline_and_merge_identity'),
        ('render', 'modern_particle_blends_match_analytical_destination_composition'),
    ]:
        code += '#[test]\n' + block(source[name], 'fn ' + marker + '(') + '\n'
    code += '}\n' + source['fixture']
    harness = output / 'harness.rs'
    harness.write_text(code)
    return harness, [{'path': str(path), 'sha256': digest(path)} for path in paths.values()]


def dependency(explicit, directory, name):
    if explicit:
        if not explicit.is_file():
            raise ValueError(f'Missing native rlib: {explicit}')
        return explicit.resolve()
    candidates = list(directory.glob(f'lib{name}-*.rlib'))
    if not candidates:
        raise ValueError(f'No native {name} rlib in {directory}; supply a compatible existing build.')
    return max(candidates, key=lambda path: path.stat().st_mtime_ns).resolve()


def run(command, output, name, repo):
    result = subprocess.run([str(value) for value in command], cwd=repo, capture_output=True, text=True)
    (output / f'{name}.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        raise ValueError(f'{name} failed ({result.returncode}); inspect {output / (name + ".log")}')
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True, help='Fresh local output directory; existing paths are refused')
    parser.add_argument('--deps-dir', type=Path, help='Existing native dependency directory (default: REPO/target/debug/deps)')
    parser.add_argument('--rustc', default=shutil.which('rustc'), help='Rust compiler compatible with the existing rlibs')
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
        libraries = {'wgpu': dependency(args.wgpu_rlib, deps, 'wgpu'),
                     'futures_lite': dependency(args.futures_lite_rlib, deps, 'futures_lite')}
        output.mkdir(parents=True, exist_ok=False)
        harness, sources = generate(repo, output)
        common = [args.rustc, '--edition', '2021', harness, '-L', f'dependency={deps}']
        for name, path in libraries.items():
            common.extend(['--extern', f'{name}={path}'])
        tests, gpu = output / 'policy-tests', output / 'gpu-check'
        run([*common, '--test', '-o', tests], output, 'compile-policy', repo)
        policy_log = run([tests, '--nocapture'], output, 'policy', repo)
        if '3 passed; 0 failed' not in policy_log:
            raise ValueError('Expected all three source policy tests to execute.')
        run([*common, '-o', gpu], output, 'compile-gpu', repo)
        gpu_log = run([gpu, output], output, 'gpu', repo)
        if gpu_log.count('PASS ') != GPU_READBACKS:
            raise ValueError(f'Expected all {GPU_READBACKS} GPU readbacks to execute.')
        report = {'schema': 1, 'status': 'passed', 'policyTests': 3, 'gpuReadbacks': GPU_READBACKS,
                  'proofBoundary': PROOF, 'syntheticTextureRGBA': [64, 96, 160, 'case alpha'],
                  'syntheticTrackRGBA': [.5, .25, .125, 'case alpha'], 'sourceFiles': sources,
                  'generatorSHA256': digest(Path(__file__)), 'harnessSHA256': digest(harness),
                  'nativeLibraries': {name: str(path) for name, path in libraries.items()},
                  'shaderDefines': {name: sorted(defines) for name, defines in VARIANTS.items()}}
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status': 'passed', 'policyTests': 3, 'gpuReadbacks': GPU_READBACKS,
                          'report': str(output / 'report.json'), 'proofBoundary': PROOF}))
    except (ValueError, OSError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
