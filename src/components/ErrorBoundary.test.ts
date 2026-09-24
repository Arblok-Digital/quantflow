import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * Regresi bug "klik MTF / ganti TF di dashboard tidak mengubah chart"
 * (2026-09-24): ErrorBoundary dulu menyimpan props.children di constructor
 * (`this.child`) dan render() mengembalikan snapshot itu selamanya — React
 * menerima element reference sama → seluruh subtree dalam boundary beku pada
 * props mount-time (state App berubah, UI tab tidak pernah ikut).
 */
describe("ErrorBoundary — children tidak boleh dibekukan", () => {
  it("render() memakai props.children TERKINI, bukan snapshot constructor", () => {
    const mountChild = "child-saat-mount";
    const updatedChild = "child-setelah-parent-update";
    const boundary = new ErrorBoundary({ children: mountChild });

    expect(boundary.render()).toBe(mountChild);

    // React memanggil render() lagi dengan props terbaru saat parent re-render.
    (boundary as unknown as { props: { children: string } }).props = { children: updatedChild };
    expect(boundary.render()).toBe(updatedChild);
    // Inilah yang dulu gagal: render() harus berubah mengikuti props.
    expect(boundary.render()).not.toBe(mountChild);
  });

  it("saat error → render fallback, bukan children mentah", () => {
    const boundary = new ErrorBoundary({ children: "kid" });
    (boundary as unknown as { state: { error: Error } }).state = { error: new Error("boom") };
    const out = boundary.render();
    expect(out).not.toBe("kid");
    expect(out).toBeTruthy();
  });
});
