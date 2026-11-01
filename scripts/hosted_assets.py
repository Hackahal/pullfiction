"""Deterministic local-only hosted asset chunk format and independent auditor."""
import gzip
import hashlib
import json
from pathlib import Path
import re

CHUNK_BYTES = 16 * 1024 * 1024
MAX_COMPRESSED = 25 * 1024 * 1024
HEX = re.compile(r'^[0-9a-f]{64}$')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def revision(manifest):
    return digest(json_bytes({k:v for k,v in manifest.items() if k != 'revision'}))


class ChunkWriter:
    def __init__(self, output, build, chunk_bytes=CHUNK_BYTES, max_bytes=64*1024**3, max_files=500000):
        if not 0 < chunk_bytes <= CHUNK_BYTES:
            raise ValueError('Chunk raw budget must be between 1 and 16 MiB')
        self.output = Path(output)
        if self.output.exists():
            raise FileExistsError('Output must be a fresh directory')
        self.output.mkdir(parents=True)
        (self.output/'chunks').mkdir()
        self.limit, self.max_bytes, self.max_files = chunk_bytes, max_bytes, max_files
        self.pending = bytearray()
        self.references = []
        self.total = 0
        self.manifest = {'schema':1, 'build':build, 'chunks':{}, 'files':{}}
        self._contents = {}

    def flush(self):
        if not self.pending:
            return
        raw = bytes(self.pending)
        compressed = gzip.compress(raw, compresslevel=6, mtime=0)
        sha = digest(compressed)
        if len(compressed) >= MAX_COMPRESSED:
            raise ValueError('Compressed chunk exceeds static service budget')
        (self.output/'chunks'/(sha+'.bin.gz')).write_bytes(compressed)
        self.manifest['chunks'][sha] = {'bytes':len(compressed), 'rawBytes':len(raw)}
        for part in self.references:
            part['chunk'] = sha
        self.pending.clear()
        self.references.clear()

    def rebuild_dedup_index(self):
        """Rebuild the payload index after restoring a flushed local checkpoint.

        The producer restores ChunkWriter through __new__; add also invokes this
        lazily so checkpoints created before deduplication remain compatible.
        """
        self._contents = {}
        for entry in self.manifest['files'].values():
            self._contents.setdefault((entry['sha256'], entry['bytes']), entry)

    def add(self, key, data):
        if not isinstance(key, str) or ':' not in key or '\x00' in key or not key:
            raise ValueError('Invalid resource key')
        data = bytes(data)
        entry = {'parts':[], 'bytes':len(data), 'sha256':digest(data)}
        old = self.manifest['files'].get(key)
        if old:
            if (old['bytes'], old['sha256']) != (entry['bytes'], entry['sha256']):
                raise ValueError('Resource changed during preparation: '+key)
            return
        if len(self.manifest['files']) >= self.max_files:
            raise ValueError('Hosted asset total budget exceeded')
        if not hasattr(self, '_contents'):
            self.rebuild_dedup_index()
        identity = (entry['sha256'], entry['bytes'])
        previous = self._contents.get(identity)
        if previous is not None:
            entry['parts'] = [dict(part) for part in previous['parts']]
            # Pending chunks receive their content hash only at flush. Register
            # copied alias slices so they receive that same hash as the original.
            self.references.extend(part for part in entry['parts'] if not part['chunk'])
            self.manifest['files'][key] = entry
            return
        if self.total+len(data) > self.max_bytes:
            raise ValueError('Hosted asset total budget exceeded')
        self.total += len(data)
        self._contents[identity] = entry
        self.manifest['files'][key] = entry
        cursor = 0
        while cursor < len(data):
            available = self.limit-len(self.pending)
            length = min(available, len(data)-cursor)
            part = {'chunk':'', 'offset':len(self.pending), 'length':length}
            entry['parts'].append(part)
            self.references.append(part)
            self.pending.extend(data[cursor:cursor+length])
            cursor += length
            if len(self.pending) == self.limit:
                self.flush()

    def finish(self, **metadata):
        self.flush()
        if set(metadata) & set(self.manifest):
            raise ValueError('Cannot replace core manifest fields')
        self.manifest.update(metadata)
        self.manifest['revision'] = revision(self.manifest)
        (self.output/'manifest.json').write_bytes(json_bytes(self.manifest))
        return self.manifest


def audit(output):
    """Verify disk bytes, decompression budgets, every slice and full resource hash."""
    output = Path(output)
    if output.is_symlink() or any(p.is_symlink() for p in output.rglob('*')):
        raise ValueError('Symlinks are forbidden in asset output')
    if {p.name for p in output.iterdir()} - {'manifest.json','chunks','_headers'}:
        raise ValueError('Unexpected public output file')
    if sum(1 for p in output.rglob('*') if p.is_file()) > 20000:
        raise ValueError('Static asset file count budget exceeded')
    if (output/'manifest.json').stat().st_size >= MAX_COMPRESSED:
        raise ValueError('Manifest exceeds static service budget')
    manifest = json.loads((output/'manifest.json').read_bytes())
    if manifest.get('schema') != 1 or manifest.get('revision') != revision(manifest):
        raise ValueError('Invalid manifest revision/schema')
    chunks = manifest['chunks']
    # Index slices by chunk so auditing holds only one bounded raw chunk in memory.
    hashes = {key:hashlib.sha256() for key in manifest['files']}
    lengths = {key:0 for key in manifest['files']}
    # Parts may span chunks; hash in declared file order below, with bounded LRU.
    from functools import lru_cache
    @lru_cache(maxsize=2)
    def load(sha):
        if not HEX.fullmatch(sha) or sha not in chunks:
            raise ValueError('Invalid chunk reference')
        row = chunks[sha]
        if type(row['bytes']) is not int or not 0 < row['bytes'] < MAX_COMPRESSED or type(row['rawBytes']) is not int or not 0 < row['rawBytes'] <= CHUNK_BYTES:
            raise ValueError('Invalid chunk budget')
        data = (output/'chunks'/(sha+'.bin.gz')).read_bytes()
        if len(data) != row['bytes'] or digest(data) != sha:
            raise ValueError('Compressed chunk integrity failure')
        import zlib
        inflater = zlib.decompressobj(16+zlib.MAX_WBITS)
        raw = inflater.decompress(data, row['rawBytes']+1)
        if len(raw) != row['rawBytes'] or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError('Invalid decompressed chunk length')
        return raw
    referenced, singles, multiple = set(), {}, []
    def slice_bytes(raw, part):
        offset, length = part['offset'], part['length']
        if type(offset) is not int or type(length) is not int or offset < 0 or length <= 0 or offset+length > len(raw):
            raise ValueError('Resource slice outside chunk')
        return raw[offset:offset+length]
    for key, entry in manifest['files'].items():
        if type(entry['bytes']) is not int or entry['bytes'] < 0 or not HEX.fullmatch(entry['sha256']):
            raise ValueError('Invalid resource metadata')
        for part in entry['parts']:
            if part['chunk'] not in chunks: raise ValueError('Invalid chunk reference')
            referenced.add(part['chunk'])
        if len(entry['parts']) == 1:
            singles.setdefault(entry['parts'][0]['chunk'], []).append((key,entry))
        else:
            multiple.append((key,entry))
    # Most resources fit in one chunk. Audit those while each chunk is resident,
    # rather than repeatedly decompressing chunks in manifest key order.
    for sha in chunks:
        raw = load(sha)
        for key, entry in singles.get(sha, []):
            payload = slice_bytes(raw, entry['parts'][0])
            lengths[key] = len(payload)
            if len(payload) != entry['bytes'] or digest(payload) != entry['sha256']:
                raise ValueError('Resource integrity failure: '+key)
    for key, entry in multiple:
        for part in entry['parts']:
            payload = slice_bytes(load(part['chunk']), part)
            hashes[key].update(payload); lengths[key] += len(payload)
        if lengths[key] != entry['bytes'] or hashes[key].hexdigest() != entry['sha256']:
            raise ValueError('Resource integrity failure: '+key)
    if referenced != set(chunks):
        raise ValueError('Unreferenced chunk')
    actual = {p.name for p in (output/'chunks').iterdir()}
    expected = {sha+'.bin.gz' for sha in chunks}
    if not expected <= actual:
        raise ValueError('Missing chunk files')
    # Prior immutable generations may remain deployed for clients holding an old
    # manifest. Validate those objects independently before allowing retention.
    import zlib
    for filename in sorted(actual-expected):
        if not re.fullmatch(r'[0-9a-f]{64}\.bin\.gz', filename):
            raise ValueError('Unexpected chunk file')
        compressed = (output/'chunks'/filename).read_bytes()
        if len(compressed) >= MAX_COMPRESSED or digest(compressed) != filename[:64]:
            raise ValueError('Retained chunk integrity failure')
        inflater = zlib.decompressobj(16+zlib.MAX_WBITS)
        raw = inflater.decompress(compressed, CHUNK_BYTES+1)
        if not 0 < len(raw) <= CHUNK_BYTES or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError('Retained chunk decompression budget failure')
    headers = output/'_headers'
    if headers.exists():
        template = Path(__file__).resolve().parent.parent/'cloudflare/game-asset-headers'
        if headers.read_bytes() != template.read_bytes():
            raise ValueError('Unreviewed static headers')
    for key in manifest.get('appearanceInputs', []):
        if not key.startswith('read:') or key not in manifest['files']:
            raise ValueError('Missing appearance input')
    return {'status':'verified', 'revision':manifest['revision'], 'files':len(hashes), 'chunks':len(chunks),
            'bytes':sum(lengths.values()), 'compressedBytes':sum(r['bytes'] for r in chunks.values())}
