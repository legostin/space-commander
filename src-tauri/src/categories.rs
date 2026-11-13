//! Расширение файла → категория (цвет на карте и группа в статистике).

pub const CAT_OTHER: u8 = 0;
pub const CAT_VIDEO: u8 = 1;
pub const CAT_AUDIO: u8 = 2;
pub const CAT_IMAGE: u8 = 3;
pub const CAT_ARCHIVE: u8 = 4;
pub const CAT_DOC: u8 = 5;
pub const CAT_CODE: u8 = 6;
pub const CAT_EXE: u8 = 7;
pub const CAT_DISK: u8 = 8;
pub const CAT_SYSTEM: u8 = 9;
pub const CAT_DATA: u8 = 10;
pub const CAT_DIR: u8 = 100;
pub const CAT_REST: u8 = 255;

/// `ext` — в нижнем регистре, без точки.
pub fn category(ext: &str) -> u8 {
    match ext {
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" | "flv" | "mpg" | "mpeg"
        | "m2ts" | "vob" | "3gp" | "braw" | "mxf" => CAT_VIDEO,
        "mp3" | "flac" | "wav" | "ogg" | "m4a" | "aac" | "wma" | "opus" | "aiff" | "ape" | "mid" => {
            CAT_AUDIO
        }
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" | "tif" | "tiff" | "raw" | "cr2"
        | "cr3" | "nef" | "arw" | "dng" | "psd" | "psb" | "svg" | "ico" | "avif" | "exr" | "tga"
        | "dds" | "ai" | "xcf" | "kra" => CAT_IMAGE,
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "cab" | "tgz" | "lz4" | "pak"
        | "jar" | "apk" | "nupkg" | "whl" | "crate" | "deb" | "rpm" | "msix" | "appx" | "esd" | "wim" => {
            CAT_ARCHIVE
        }
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" | "rtf"
        | "txt" | "md" | "epub" | "fb2" | "djvu" | "mobi" | "csv" | "one" | "pages" | "key"
        | "numbers" => CAT_DOC,
        "rs" | "js" | "ts" | "tsx" | "jsx" | "mjs" | "py" | "c" | "cpp" | "cc" | "h" | "hpp" | "cs"
        | "java" | "kt" | "go" | "rb" | "php" | "swift" | "html" | "css" | "scss" | "json" | "xml"
        | "yaml" | "yml" | "toml" | "sh" | "ps1" | "bat" | "cmd" | "sql" | "lua" | "vue" | "svelte"
        | "map" | "ipynb" | "rlib" | "rmeta" | "o" | "obj" | "pdb" | "ilk" | "lib" | "a" | "pyc"
        | "class" | "d" | "wasm" => CAT_CODE,
        "exe" | "dll" | "msi" | "sys" | "ocx" | "com" | "scr" | "node" | "pyd" | "so" | "msp"
        | "mui" | "drv" | "cpl" | "efi" | "bin" => CAT_EXE,
        "iso" | "vhd" | "vhdx" | "vmdk" | "vdi" | "img" | "qcow2" | "wsl" | "dmg" | "ova" | "avhdx"
        | "vmem" | "nvram" => CAT_DISK,
        "tmp" | "log" | "etl" | "dmp" | "mdmp" | "bak" | "old" | "cache" | "chk" | "evtx" | "regtrans-ms"
        | "blf" | "cat" | "manifest" | "mum" | "inf" | "pf" | "lock" | "swp" => CAT_SYSTEM,
        "db" | "sqlite" | "sqlite3" | "mdb" | "accdb" | "mdf" | "ldf" | "ndf" | "edb" | "dat" | "pst"
        | "ost" | "parquet" | "h5" | "hdf5" | "npy" | "npz" | "safetensors" | "gguf" | "ckpt" | "pt"
        | "pth" | "onnx" | "pb" | "tfrecord" | "arrow" | "feather" | "ldb" | "sst" | "wal" | "idx"
        | "pack" | "blob" | "uasset" | "upk" | "vpk" | "wad" | "bsa" | "ba2" | "unity3d" | "assets"
        | "resource" | "ress" | "bundle" | "forge" | "rpf" => CAT_DATA,
        _ => CAT_OTHER,
    }
}

/// Расширение имени в нижнем регистре (ASCII) или пустая строка.
pub fn ext_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(pos) if pos > 0 && pos + 1 < name.len() => {
            let ext = &name[pos + 1..];
            if ext.len() <= 16 && ext.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                ext
            } else {
                ""
            }
        }
        _ => "",
    }
}

pub fn category_of_name(name: &str) -> u8 {
    let ext = ext_of(name);
    if ext.is_empty() {
        return CAT_OTHER;
    }
    let mut buf = [0u8; 16];
    let n = ext.len();
    buf[..n].copy_from_slice(ext.as_bytes());
    buf[..n].make_ascii_lowercase();
    category(std::str::from_utf8(&buf[..n]).unwrap_or(""))
}
