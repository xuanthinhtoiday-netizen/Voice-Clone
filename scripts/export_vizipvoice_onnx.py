"""
Export contextboxai/ViZipvoice (7,000h Vietnamese Flow-Matching) to ONNX & INT8
for 100% offline local CPU voice cloning in VoxForge Studio.

Usage:
    python scripts/export_vizipvoice_onnx.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from huggingface_hub import hf_hub_download

BASE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = BASE_DIR / "vendor" / "ViZipvoice"
OUT_DIR = BASE_DIR / "data" / "models" / "vizipvoice_onnx"

if str(VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(VENDOR_DIR))


def main() -> None:
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from zipvoice.bin.onnx_export import (
        OnnxFlowMatchingModel,
        OnnxTextModel,
        export_fm_decoder,
        export_text_encoder,
    )
    from zipvoice.models.zipvoice import ZipVoice
    from zipvoice.tokenizer.tokenizer import SimpleTokenizer
    from zipvoice.utils.checkpoint import load_checkpoint
    from zipvoice.utils.scaling_converter import convert_scaled_to_non_scaled

    repo = "contextboxai/ViZipvoice"
    print(f"Downloading {repo} checkpoint & config...")
    ckpt = Path(hf_hub_download(repo, "checkpoint-1860000.pt"))
    cfg = Path(hf_hub_download(repo, "config.json"))
    tok = Path(hf_hub_download(repo, "tokens.txt"))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cfg, OUT_DIR / "model.json")
    shutil.copy2(tok, OUT_DIR / "tokens.txt")

    t0 = time.perf_counter()
    tokenizer = SimpleTokenizer(token_file=str(tok))
    model_cfg = json.loads(cfg.read_text(encoding="utf-8"))
    model = ZipVoice(**model_cfg["model"], vocab_size=tokenizer.vocab_size, pad_id=tokenizer.pad_id)
    load_checkpoint(filename=ckpt, model=model, strict=True)
    model.to(torch.device("cpu")).eval()
    convert_scaled_to_non_scaled(model, inplace=True, is_onnx=True)

    te_path = OUT_DIR / "text_encoder.onnx"
    fm_path = OUT_DIR / "fm_decoder.onnx"

    print("Exporting text_encoder.onnx...")
    export_text_encoder(model=OnnxTextModel(model=model), filename=te_path, opset_version=13)

    print("Exporting fm_decoder.onnx...")
    export_fm_decoder(model=OnnxFlowMatchingModel(model=model, distill=False), filename=fm_path, opset_version=13)

    print("Quantizing INT8 ONNX models (in ASCII temp dir for Windows path safety)...")
    with tempfile.TemporaryDirectory() as td:
        td_p = Path(td)
        for src, dst, name in [
            (te_path, OUT_DIR / "text_encoder_int8.onnx", "text_encoder"),
            (fm_path, OUT_DIR / "fm_decoder_int8.onnx", "fm_decoder"),
        ]:
            tmp_in = td_p / f"{name}.onnx"
            tmp_out = td_p / f"{name}_int8.onnx"
            shutil.copy2(src, tmp_in)
            quantize_dynamic(
                model_input=tmp_in,
                model_output=tmp_out,
                op_types_to_quantize=["MatMul"],
                weight_type=QuantType.QInt8,
            )
            shutil.copy2(tmp_out, dst)
            print(f"  Saved {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")

    print(f"Done in {time.perf_counter() - t0:.1f}s -> {OUT_DIR}")


if __name__ == "__main__":
    main()
