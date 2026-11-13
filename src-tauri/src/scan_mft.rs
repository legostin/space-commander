//! Быстрый режим: читаем главную таблицу файлов NTFS ($MFT) напрямую с тома.
//!
//! Вместо обхода миллионов папок — одно последовательное чтение таблицы, где уже
//! лежат имена, размеры и родитель каждого файла. Для этого нужен дескриптор тома
//! `\\.\C:`, а его Windows выдаёт только администраторам. Том открывается только
//! на чтение.

use crate::scan_walk::Progress;
use crate::tree::*;
use crate::winutil::{self, filetime_to_unix, wide};
use rayon::prelude::*;
use std::ptr::{null, null_mut};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::mpsc::sync_channel;
use std::time::Instant;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile};
use windows_sys::Win32::System::IO::{DeviceIoControl, OVERLAPPED};

const FSCTL_GET_NTFS_VOLUME_DATA: u32 = 0x0009_0064;
const FSCTL_GET_RETRIEVAL_POINTERS: u32 = 0x0009_0073;
const GENERIC_READ: u32 = 0x8000_0000;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const SHARE_ALL: u32 = 7;
const OPEN_EXISTING: u32 = 3;
const ERROR_MORE_DATA: u32 = 234;

const ROOT_RECORD: u32 = 5;
const BAD_CLUS_RECORD: u64 = 8;
const NO_PARENT: u32 = u32::MAX;

#[inline]
fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
#[inline]
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

struct Handle(HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn open(path: &str, access: u32) -> Result<Handle, u32> {
    let w = wide(path);
    let h = unsafe { CreateFileW(w.as_ptr(), access, SHARE_ALL, null(), OPEN_EXISTING, 0, null_mut()) };
    if h == INVALID_HANDLE_VALUE {
        Err(unsafe { GetLastError() })
    } else {
        Ok(Handle(h))
    }
}

fn read_at(h: &Handle, offset: u64, buf: &mut [u8]) -> Result<(), String> {
    let mut done = 0usize;
    while done < buf.len() {
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        let pos = offset + done as u64;
        ov.Anonymous.Anonymous.Offset = pos as u32;
        ov.Anonymous.Anonymous.OffsetHigh = (pos >> 32) as u32;
        let mut read = 0u32;
        let want = (buf.len() - done).min(64 << 20) as u32;
        let ok = unsafe { ReadFile(h.0, buf[done..].as_mut_ptr(), want, &mut read, &mut ov) };
        if ok == 0 || read == 0 {
            return Err(format!("Ошибка чтения тома (код {})", unsafe { GetLastError() }));
        }
        done += read as usize;
    }
    Ok(())
}

struct Volume {
    bytes_per_cluster: u64,
    record_size: usize,
    mft_valid_len: u64,
    mft_start_lcn: u64,
    total_bytes: u64,
}

fn volume_data(h: &Handle) -> Result<Volume, String> {
    let mut buf = [0u8; 128];
    let mut ret = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            h.0,
            FSCTL_GET_NTFS_VOLUME_DATA,
            null(),
            0,
            buf.as_mut_ptr() as *mut _,
            buf.len() as u32,
            &mut ret,
            null_mut(),
        )
    };
    if ok == 0 || ret < 96 {
        return Err("Том не является NTFS".into());
    }
    let v = Volume {
        total_bytes: u64_at(&buf, 16) * u32_at(&buf, 44) as u64,
        bytes_per_cluster: u32_at(&buf, 44) as u64,
        record_size: u32_at(&buf, 48) as usize,
        mft_valid_len: u64_at(&buf, 56),
        mft_start_lcn: u64_at(&buf, 64),
    };
    if v.bytes_per_cluster == 0 || v.record_size < 512 || v.record_size > 65536 || !v.record_size.is_power_of_two() {
        return Err("Неожиданная геометрия NTFS".into());
    }
    Ok(v)
}

/// Фрагменты $MFT: (смещение на томе в байтах, длина в байтах), в логическом порядке.
type Extents = Vec<(u64, u64)>;

/// Основной способ: спросить у Windows карту размещения файла `$MFT`.
fn extents_via_fsctl(letter: char, bpc: u64) -> Option<Extents> {
    let h = open(&format!(r"\\.\{}:\$MFT", letter), FILE_READ_ATTRIBUTES)
        .or_else(|_| open(&format!(r"{}:\$MFT", letter), FILE_READ_ATTRIBUTES))
        .ok()?;
    let mut out: Extents = Vec::new();
    let mut start_vcn: i64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let mut ret = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                h.0,
                FSCTL_GET_RETRIEVAL_POINTERS,
                &start_vcn as *const i64 as *const _,
                8,
                buf.as_mut_ptr() as *mut _,
                buf.len() as u32,
                &mut ret,
                null_mut(),
            )
        };
        let err = unsafe { GetLastError() };
        if ok == 0 && err != ERROR_MORE_DATA {
            return None;
        }
        if ret < 16 {
            return None;
        }
        let count = u32_at(&buf, 0) as usize;
        let mut prev = u64_at(&buf, 8) as i64;
        let fit = ((ret as usize - 16) / 16).min(count);
        for i in 0..fit {
            let next = u64_at(&buf, 16 + i * 16) as i64;
            let lcn = u64_at(&buf, 24 + i * 16) as i64;
            if lcn < 0 || next <= prev {
                return None;
            }
            out.push((lcn as u64 * bpc, (next - prev) as u64 * bpc));
            prev = next;
        }
        if ok != 0 || fit == 0 {
            break;
        }
        start_vcn = prev;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Проверяет подпись записи и восстанавливает байты, подменённые защитой от обрыва записи.
fn apply_fixup(rec: &mut [u8]) -> bool {
    if rec.len() < 48 || &rec[0..4] != b"FILE" {
        return false;
    }
    let usa_off = u16_at(rec, 4) as usize;
    let usa_cnt = u16_at(rec, 6) as usize;
    if usa_cnt < 2 {
        return true;
    }
    let stride = rec.len() / (usa_cnt - 1);
    if stride < 16 || usa_off + usa_cnt * 2 > rec.len() {
        return false;
    }
    let usn = [rec[usa_off], rec[usa_off + 1]];
    for i in 1..usa_cnt {
        let end = i * stride;
        if end > rec.len() {
            break;
        }
        if rec[end - 2] != usn[0] || rec[end - 1] != usn[1] {
            return false;
        }
        rec[end - 2] = rec[usa_off + 2 * i];
        rec[end - 1] = rec[usa_off + 2 * i + 1];
    }
    true
}

/// Разбирает список отрезков нерезидентного атрибута.
fn decode_runs(rec: &[u8], mut pos: usize, end: usize, bpc: u64) -> Option<Extents> {
    let mut out = Vec::new();
    let mut lcn: i64 = 0;
    while pos < end {
        let head = rec[pos];
        if head == 0 {
            break;
        }
        let len_sz = (head & 0x0F) as usize;
        let off_sz = (head >> 4) as usize;
        pos += 1;
        if len_sz == 0 || len_sz > 8 || off_sz > 8 || pos + len_sz + off_sz > end {
            return None;
        }
        let mut len: u64 = 0;
        for i in 0..len_sz {
            len |= (rec[pos + i] as u64) << (8 * i);
        }
        pos += len_sz;
        if off_sz == 0 {
            return None; // разрежённый отрезок в $MFT невозможен
        }
        let mut delta: i64 = 0;
        for i in 0..off_sz {
            delta |= (rec[pos + i] as i64) << (8 * i);
        }
        let shift = 64 - 8 * off_sz as u32;
        delta = (delta << shift) >> shift; // знаковое расширение
        pos += off_sz;
        lcn += delta;
        if lcn < 0 {
            return None;
        }
        out.push((lcn as u64 * bpc, len * bpc));
    }
    Some(out)
}

/// Запасной способ: разобрать запись №0 ($MFT описывает сам себя).
fn extents_via_record0(h: &Handle, v: &Volume) -> Result<Extents, String> {
    let mut rec = vec![0u8; v.record_size.max(4096)];
    read_at(h, v.mft_start_lcn * v.bytes_per_cluster, &mut rec)?;
    rec.truncate(v.record_size);
    if !apply_fixup(&mut rec) {
        return Err("Запись $MFT повреждена".into());
    }
    let used = (u32_at(&rec, 24) as usize).min(rec.len());
    let mut off = u16_at(&rec, 20) as usize;
    while off + 16 <= used {
        let ty = u32_at(&rec, off);
        if ty == 0xFFFF_FFFF {
            break;
        }
        let len = u32_at(&rec, off + 4) as usize;
        if len < 16 || off + len > used {
            break;
        }
        if ty == 0x80 && rec[off + 8] != 0 && rec[off + 9] == 0 && off + 64 <= used {
            let run_off = u16_at(&rec, off + 32) as usize;
            return decode_runs(&rec, off + run_off, off + len, v.bytes_per_cluster)
                .ok_or_else(|| "Не удалось разобрать размещение $MFT".to_string());
        }
        off += len;
    }
    Err("В записи $MFT нет атрибута данных".into())
}

struct RawRec {
    recno: u32,
    /// 0 — основная запись; иначе номер основной, которую эта дополняет.
    base: u32,
    parent: u32,
    name_off: u32,
    name_len: u16,
    flags: u16,
    has_data: bool,
    size: u64,
    alloc: u64,
    mtime: i64,
}

#[derive(Default)]
struct ChunkOut {
    recs: Vec<RawRec>,
    names: Vec<u8>,
}

fn parse_record(rec: &mut [u8], recno: u64, volume_bytes: u64, out: &mut ChunkOut) {
    if recno > u32::MAX as u64 - 2 || !apply_fixup(rec) {
        return;
    }
    let hdr_flags = u16_at(rec, 22);
    if hdr_flags & 1 == 0 {
        return; // запись свободна
    }
    let is_dir = hdr_flags & 2 != 0;
    let used = (u32_at(rec, 24) as usize).min(rec.len());
    let base = u64_at(rec, 32) & 0xFFFF_FFFF_FFFF;
    if base > u32::MAX as u64 - 2 {
        return;
    }

    let mut parent = NO_PARENT;
    let mut name: Option<(usize, usize, u8)> = None;
    let (mut size, mut alloc, mut has_data) = (0u64, 0u64, false);
    let mut mtime = 0i64;
    let mut attrs = 0u32;
    let mut surrogate = false;

    let mut off = u16_at(rec, 20) as usize;
    while off + 16 <= used {
        let ty = u32_at(rec, off);
        if ty == 0xFFFF_FFFF {
            break;
        }
        let len = u32_at(rec, off + 4) as usize;
        if len < 16 || off + len > used {
            break;
        }
        let end = off + len;
        let nonres = rec[off + 8] != 0;
        let attr_name_len = rec[off + 9];
        if !nonres && len >= 24 {
            let c = off + u16_at(rec, off + 20) as usize;
            let clen = u32_at(rec, off + 16) as usize;
            match ty {
                0x10 if c + 36 <= end => {
                    mtime = filetime_to_unix(u64_at(rec, c + 8));
                    attrs = u32_at(rec, c + 32);
                }
                0x30 if c + 66 <= end => {
                    let nl = rec[c + 64] as usize;
                    let ns = rec[c + 65];
                    // Пространство имён 2 — короткое DOS-имя; берём его, только если другого нет.
                    let better = match name {
                        None => true,
                        Some((_, _, prev_ns)) => prev_ns == 2 && ns != 2,
                    };
                    if nl > 0 && c + 66 + nl * 2 <= end && better {
                        let p = u64_at(rec, c) & 0xFFFF_FFFF_FFFF;
                        parent = if p < NO_PARENT as u64 { p as u32 } else { NO_PARENT };
                        name = Some((c + 66, nl, ns));
                    }
                }
                0x80 if attr_name_len == 0 => {
                    size = clen as u64;
                    has_data = true;
                }
                0xC0 if c + 4 <= end => {
                    surrogate = u32_at(rec, c) & 0x2000_0000 != 0;
                }
                _ => {}
            }
        } else if nonres && len >= 64 && (ty == 0x80 || ty == 0xA0) {
            // Размеры хранит только первый кусок атрибута (lowest VCN = 0).
            if u64_at(rec, off + 16) == 0 {
                let comp_unit = u16_at(rec, off + 34);
                let mut on_disk = if comp_unit != 0 && len >= 72 {
                    u64_at(rec, off + 64) // сжатый или разрежённый: фактически занято
                } else {
                    u64_at(rec, off + 40)
                };
                // Запись №8 ($BadClus) содержит поток $Bad размером со весь том: он только
                // помечает сбойные кластеры и места не занимает.
                if on_disk >= volume_bytes || recno == BAD_CLUS_RECORD {
                    on_disk = 0;
                }
                if ty == 0x80 && attr_name_len == 0 {
                    size = u64_at(rec, off + 48);
                    has_data = true;
                }
                // Именованные потоки (в т.ч. WofCompressedData) и индексы папок тоже занимают место.
                alloc += on_disk;
            }
        }
        off = end;
    }

    let mut flags = 0u16;
    if is_dir {
        flags |= F_DIR;
        size = 0;
    }
    if attrs & 0x2 != 0 {
        flags |= F_HIDDEN;
    }
    if attrs & 0x4 != 0 {
        flags |= F_SYSTEM;
    }
    if attrs & 0x800 != 0 {
        flags |= F_COMPRESSED;
    }
    if attrs & 0x200 != 0 {
        flags |= F_SPARSE;
    }
    if surrogate {
        flags |= F_REPARSE;
    }
    if attrs & (0x1000 | 0x4_0000 | 0x40_0000) != 0 {
        flags |= F_CLOUD;
    }

    let name_off = out.names.len() as u32;
    if let Some((pos, nl, _)) = name {
        let units = rec[pos..pos + nl * 2].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]));
        for ch in char::decode_utf16(units) {
            let c = ch.unwrap_or(char::REPLACEMENT_CHARACTER);
            let mut b = [0u8; 4];
            out.names.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
        }
    }
    out.recs.push(RawRec {
        recno: recno as u32,
        base: base as u32,
        parent,
        name_off,
        name_len: (out.names.len() as u32 - name_off) as u16,
        flags,
        has_data,
        size,
        alloc,
        mtime,
    });
}

#[derive(Clone, Copy)]
struct Entry {
    size: u64,
    alloc: u64,
    mtime: i64,
    parent: u32,
    name_off: u32,
    name_len: u16,
    flags: u16,
    used: bool,
}

const EMPTY: Entry =
    Entry { size: 0, alloc: 0, mtime: 0, parent: NO_PARENT, name_off: 0, name_len: 0, flags: 0, used: false };

/// Сканирует том целиком. `letter` — буква диска.
pub fn scan(letter: char, progress: &Progress) -> Result<Tree, String> {
    let started = Instant::now();
    let letter = letter.to_ascii_uppercase();
    let vol = open(&format!(r"\\.\{}:", letter), GENERIC_READ).map_err(|code| match code {
        5 => "Нет доступа к тому: быстрый режим требует прав администратора".to_string(),
        c => format!("Не удалось открыть том {}: (код {})", letter, c),
    })?;
    let v = volume_data(&vol)?;
    let bpc = v.bytes_per_cluster;

    let mut extents = match extents_via_fsctl(letter, bpc) {
        Some(e) => e,
        None => extents_via_record0(&vol, &v)?,
    };
    let covered: u64 = extents.iter().map(|e| e.1).sum();
    if covered < v.mft_valid_len {
        // Часть карты размещения лежит в дополнительных записях — пробуем запасной способ целиком.
        let alt = extents_via_record0(&vol, &v)?;
        if alt.iter().map(|e| e.1).sum::<u64>() < v.mft_valid_len {
            return Err("Таблица файлов слишком фрагментирована для быстрого чтения".into());
        }
        extents = alt;
    }

    let rs = v.record_size;
    let total_records = (v.mft_valid_len / rs as u64) as usize;
    progress.total.store(v.mft_valid_len, Relaxed);

    // Кусок кратен и кластеру, и записи — чтения выровнены по секторам.
    let unit = bpc.max(rs as u64);
    let chunk = ((8u64 << 20) / unit).max(1) * unit;

    let mut entries: Vec<Entry> = vec![EMPTY; total_records];
    let mut names: Vec<u8> = Vec::with_capacity(total_records * 14);
    let mut ext_recs: Vec<RawRec> = Vec::new();
    let mut ext_names: Vec<u8> = Vec::new();

    let read_result: Result<(), String> = std::thread::scope(|scope| {
        let (tx, rx) = sync_channel::<(u64, Vec<u8>)>(6);
        let vol_ref = &vol;
        let extents_ref = &extents;
        let valid = v.mft_valid_len;
        let reader = scope.spawn(move || -> Result<(), String> {
            let mut log_off = 0u64;
            while log_off < valid {
                if progress.cancel.load(Relaxed) {
                    return Err("cancelled".into());
                }
                let len = chunk.min((valid - log_off).div_ceil(unit) * unit);
                let mut buf = vec![0u8; len as usize];
                // Логический диапазон [log_off, log_off+len) собираем из физических фрагментов.
                let mut ext_start = 0u64;
                for &(phys, elen) in extents_ref.iter() {
                    let ext_end = ext_start + elen;
                    if ext_end > log_off && ext_start < log_off + len {
                        let from = log_off.max(ext_start);
                        let to = (log_off + len).min(ext_end);
                        let dst = &mut buf[(from - log_off) as usize..(to - log_off) as usize];
                        read_at(vol_ref, phys + (from - ext_start), dst)?;
                    }
                    ext_start = ext_end;
                    if ext_start >= log_off + len {
                        break;
                    }
                }
                progress.done.fetch_add(len.min(valid - log_off), Relaxed);
                if tx.send((log_off, buf)).is_err() {
                    break;
                }
                log_off += len;
            }
            Ok(())
        });

        for (log_off, mut buf) in rx {
            let first = log_off / rs as u64;
            let outs: Vec<ChunkOut> = buf
                .par_chunks_mut(rs)
                .enumerate()
                .fold(ChunkOut::default, |mut acc, (i, rec)| {
                    parse_record(rec, first + i as u64, v.total_bytes, &mut acc);
                    acc
                })
                .collect();
            let (mut n_files, mut n_dirs, mut n_bytes) = (0u64, 0u64, 0u64);
            for co in outs {
                for r in co.recs {
                    let src = &co.names[r.name_off as usize..r.name_off as usize + r.name_len as usize];
                    if r.base != 0 {
                        let off = ext_names.len() as u32;
                        ext_names.extend_from_slice(src);
                        ext_recs.push(RawRec { name_off: off, ..r });
                        continue;
                    }
                    let Some(slot) = entries.get_mut(r.recno as usize) else { continue };
                    let off = names.len() as u32;
                    names.extend_from_slice(src);
                    if r.flags & F_DIR != 0 {
                        n_dirs += 1;
                    } else {
                        n_files += 1;
                        n_bytes += r.size;
                    }
                    *slot = Entry {
                        size: r.size,
                        alloc: r.alloc,
                        mtime: r.mtime,
                        parent: r.parent,
                        name_off: off,
                        name_len: r.name_len,
                        flags: r.flags,
                        used: true,
                    };
                }
            }
            progress.files.fetch_add(n_files, Relaxed);
            progress.dirs.fetch_add(n_dirs, Relaxed);
            progress.bytes.fetch_add(n_bytes, Relaxed);
        }
        reader.join().unwrap_or_else(|_| Err("Сбой потока чтения".into()))
    });
    read_result?;
    drop(vol);

    // Дополнительные записи: размеры и имена файлов с длинным списком атрибутов.
    for r in &ext_recs {
        let Some(e) = entries.get_mut(r.base as usize) else { continue };
        if !e.used {
            continue;
        }
        if r.has_data && e.flags & F_DIR == 0 {
            e.size = r.size;
        }
        e.alloc += r.alloc;
        if e.name_len == 0 && r.name_len > 0 {
            let off = names.len() as u32;
            names.extend_from_slice(&ext_names[r.name_off as usize..r.name_off as usize + r.name_len as usize]);
            e.name_off = off;
            e.name_len = r.name_len;
            e.parent = r.parent;
        }
    }
    drop(ext_recs);
    drop(ext_names);

    if entries.len() <= ROOT_RECORD as usize || !entries[ROOT_RECORD as usize].used {
        return Err("В таблице файлов нет корневого каталога".into());
    }

    // Группируем записи по родителю (сортировка подсчётом), затем раскладываем в ширину:
    // дети каждого каталога оказываются в арене подряд.
    let is_child = |r: usize, e: &Entry| {
        e.used && e.name_len > 0 && r != ROOT_RECORD as usize && (e.parent as usize) < total_records
    };
    let mut start = vec![0u32; total_records + 1];
    for (r, e) in entries.iter().enumerate() {
        if is_child(r, e) {
            start[e.parent as usize + 1] += 1;
        }
    }
    for i in 0..total_records {
        start[i + 1] += start[i];
    }
    let mut cursor = start.clone();
    let mut order = vec![0u32; start[total_records] as usize];
    for (r, e) in entries.iter().enumerate() {
        if is_child(r, e) {
            let c = &mut cursor[e.parent as usize];
            order[*c as usize] = r as u32;
            *c += 1;
        }
    }
    drop(cursor);

    let root_path = format!("{}:\\", letter);
    let mut nodes: Vec<Node> = Vec::with_capacity(order.len() + 1);
    let mut node_rec: Vec<u32> = Vec::with_capacity(order.len() + 1);
    let root_e = &entries[ROOT_RECORD as usize];
    nodes.push(Node { alloc: root_e.alloc, mtime: root_e.mtime, flags: F_DIR, ..Default::default() });
    node_rec.push(ROOT_RECORD);
    let mut i = 0usize;
    while i < nodes.len() {
        if nodes[i].flags & F_DIR != 0 {
            let r = node_rec[i] as usize;
            let kids = &order[start[r] as usize..start[r + 1] as usize];
            if !kids.is_empty() {
                nodes[i].first_child = nodes.len() as u32;
                nodes[i].child_count = kids.len() as u32;
                for &k in kids {
                    let e = &entries[k as usize];
                    let is_dir = e.flags & F_DIR != 0;
                    nodes.push(Node {
                        size: e.size,
                        alloc: e.alloc,
                        mtime: e.mtime,
                        parent: i as u32,
                        first_child: 0,
                        child_count: 0,
                        files: if is_dir { 0 } else { 1 },
                        name_off: e.name_off,
                        name_len: e.name_len,
                        flags: e.flags,
                    });
                    node_rec.push(k);
                }
            }
        }
        i += 1;
    }
    drop(entries);
    drop(order);
    drop(node_rec);
    nodes.shrink_to_fit();
    names.shrink_to_fit();

    let mut tree = Tree {
        nodes,
        names,
        root_path,
        mode: "mft",
        duration_ms: 0,
        denied: Vec::new(),
        scanned_at: winutil::now_unix(),
        ..Default::default()
    };
    tree.finalize();
    tree.duration_ms = started.elapsed().as_millis() as u64;
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put16(b: &mut [u8], o: usize, v: u16) {
        b[o..o + 2].copy_from_slice(&v.to_le_bytes());
    }
    fn put32(b: &mut [u8], o: usize, v: u32) {
        b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put64(b: &mut [u8], o: usize, v: u64) {
        b[o..o + 8].copy_from_slice(&v.to_le_bytes());
    }

    /// Собирает запись MFT с $STANDARD_INFORMATION, $FILE_NAME и нерезидентным $DATA.
    fn make_record(name: &str, parent: u64, real: u64, allocated: u64, dir: bool) -> Vec<u8> {
        let mut r = vec![0u8; 1024];
        r[0..4].copy_from_slice(b"FILE");
        put16(&mut r, 4, 48); // смещение массива fixup
        put16(&mut r, 6, 3); // 1 контрольное значение + 2 сектора
        put16(&mut r, 20, 56); // первый атрибут
        put16(&mut r, 22, if dir { 3 } else { 1 });
        let mut off = 56;

        // $STANDARD_INFORMATION
        put32(&mut r, off, 0x10);
        put32(&mut r, off + 4, 24 + 48);
        put32(&mut r, off + 16, 48);
        put16(&mut r, off + 20, 24);
        put64(&mut r, off + 24 + 8, 116_444_736_000_000_000 + 1_700_000_000 * 10_000_000);
        put32(&mut r, off + 24 + 32, 0x2); // скрытый
        off += 72;

        // $FILE_NAME
        let w: Vec<u16> = name.encode_utf16().collect();
        let clen = 66 + w.len() * 2;
        let alen = (24 + clen + 7) & !7;
        put32(&mut r, off, 0x30);
        put32(&mut r, off + 4, alen as u32);
        put32(&mut r, off + 16, clen as u32);
        put16(&mut r, off + 20, 24);
        put64(&mut r, off + 24, parent | (7u64 << 48)); // номер + порядковый номер
        r[off + 24 + 64] = w.len() as u8;
        r[off + 24 + 65] = 1;
        for (i, u) in w.iter().enumerate() {
            put16(&mut r, off + 24 + 66 + i * 2, *u);
        }
        off += alen;

        if !dir {
            // нерезидентный $DATA
            put32(&mut r, off, 0x80);
            put32(&mut r, off + 4, 72);
            r[off + 8] = 1;
            put16(&mut r, off + 32, 64);
            put64(&mut r, off + 40, allocated);
            put64(&mut r, off + 48, real);
            off += 72;
        }
        put32(&mut r, off, 0xFFFF_FFFF);
        put32(&mut r, 24, off as u32 + 8);

        // Защита от обрыва записи: концы секторов заменены контрольным значением.
        put16(&mut r, 48, 0xABCD);
        for i in 1..3 {
            let end = i * 512;
            let orig = [r[end - 2], r[end - 1]];
            r[48 + 2 * i] = orig[0];
            r[48 + 2 * i + 1] = orig[1];
            put16(&mut r, end - 2, 0xABCD);
        }
        r
    }

    #[test]
    fn parses_file_record() {
        let mut rec = make_record("Отчёт 2026.xlsx", 1234, 5_000_000, 5_001_216, false);
        let mut out = ChunkOut::default();
        parse_record(&mut rec, 77, 1 << 40, &mut out);
        assert_eq!(out.recs.len(), 1);
        let r = &out.recs[0];
        assert_eq!((r.recno, r.base, r.parent), (77, 0, 1234));
        assert_eq!((r.size, r.alloc, r.has_data), (5_000_000, 5_001_216, true));
        assert_eq!(r.mtime, 1_700_000_000);
        assert_eq!(r.flags & F_HIDDEN, F_HIDDEN);
        assert_eq!(std::str::from_utf8(&out.names).unwrap(), "Отчёт 2026.xlsx");
    }

    #[test]
    fn rejects_torn_and_free_records() {
        let mut torn = make_record("a.txt", 5, 1, 4096, false);
        torn[510] = 0; // контрольное значение не совпало — запись записана наполовину
        let mut out = ChunkOut::default();
        parse_record(&mut torn, 1, 1 << 40, &mut out);
        assert!(out.recs.is_empty());

        let mut free = make_record("b.txt", 5, 1, 4096, false);
        put16(&mut free, 22, 0);
        parse_record(&mut free, 2, 1 << 40, &mut out);
        assert!(out.recs.is_empty());

        let mut garbage = vec![0u8; 1024];
        parse_record(&mut garbage, 3, 1 << 40, &mut out);
        assert!(out.recs.is_empty());
    }

    #[test]
    fn bad_cluster_file_takes_no_space() {
        // Тот же файл в записи №8 — это $BadClus: «занимает» весь том только на бумаге.
        let mut rec = make_record("$BadClus", 5, 0, 1 << 39, false);
        let mut out = ChunkOut::default();
        parse_record(&mut rec, 8, 1 << 40, &mut out);
        assert_eq!(out.recs[0].alloc, 0);
        let mut normal = make_record("big.bin", 5, 1 << 39, 1 << 39, false);
        parse_record(&mut normal, 9, 1 << 40, &mut out);
        assert_eq!(out.recs[1].alloc, 1 << 39);
    }

    #[test]
    fn directory_has_no_size() {
        let mut rec = make_record("Windows", 5, 0, 0, true);
        let mut out = ChunkOut::default();
        parse_record(&mut rec, 40, 1 << 40, &mut out);
        assert_eq!(out.recs[0].flags & F_DIR, F_DIR);
        assert_eq!(out.recs[0].size, 0);
    }

    #[test]
    fn decodes_run_list() {
        // 0x31: длина 1 байт, смещение 3 байта; затем отрезок с отрицательным смещением.
        let runs = [0x31, 0x10, 0x00, 0x00, 0x04, 0x11, 0x08, 0xF0, 0x00];
        let e = decode_runs(&runs, 0, runs.len(), 4096).unwrap();
        assert_eq!(e[0], (0x040000 * 4096, 0x10 * 4096));
        assert_eq!(e[1], ((0x040000 - 16) * 4096, 8 * 4096));
    }
}
