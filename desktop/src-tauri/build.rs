// Tauri's build script. It generates the context that `generate_context!`
// expands into — icons, config, capabilities — and sets the OUT_DIR that macro
// reads from. Without this file the macro fails with "OUT_DIR env var is not
// set", which is a confusing way to say "there's no build script".
fn main() {
    tauri_build::build()
}
