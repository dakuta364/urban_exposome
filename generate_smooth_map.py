import os
import rasterio
from rasterio.enums import Resampling
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "."))
INPUT_DIR = os.path.join(BASE_DIR, "data")
OUTPUT_DIR = os.path.join(BASE_DIR, "frontend", "overlays")

SMOOTH_FACTOR = 3

os.makedirs(OUTPUT_DIR, exist_ok=True)

CONFIG = {
    "light": {
        "input": "crimea_light.tif",
        "output": "light.png",
        "vmin": 0.0, 
        "vmax": 60.0, 
        "colors": ['black', 'darkblue', 'purple', 'red', 'yellow', 'white'], 
        "mask_func": lambda d: d > 0.5 
    },
    "heat": {
        "input": "crimea_heat.tif",
        "output": "heat.png",
        "vmin": 25.0, 
        "vmax": 45.0, 
        "colors": ['blue', 'cyan', 'green', 'yellow', 'red'], 
        "mask_func": lambda d: d > 0 
    },
    "no2": {
        "input": "crimea_no2.tif",
        "output": "no2.png",
        "vmin": 0.0, 
        "vmax": 40.0, 
        "colors": ['green', 'yellow', 'orange', 'red', 'purple'], 
        "mask_func": lambda d: d > 0.1 
    },
    "noise": {
        "input": "crimea_noise.tif",
        "output": "noise.png",
        "vmin": 35.0, 
        "vmax": 75.0, 
        "colors": ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59', '#d73027', '#67001f'], 
        "mask_func": lambda d: d >= 30.0 
    }
}

print("=== ЗАПУСК ГЕНЕРАЦИИ КАРТ ЭКСПОСОМА ===")

for layer_id, cfg in CONFIG.items():
    in_path = os.path.join(INPUT_DIR, cfg["input"])
    out_path = os.path.join(OUTPUT_DIR, cfg["output"])
    
    if not os.path.exists(in_path):
        print(f"[ПРОПУСК] Исходный файл не найден: {in_path}")
        continue
        
    print(f"Обработка слоя: {layer_id} ...")
    
    try:
        with rasterio.open(in_path) as src:
            out_shape = (int(src.height * SMOOTH_FACTOR), int(src.width * SMOOTH_FACTOR))
            data = src.read(
                1,
                out_shape=out_shape,
                resampling=Resampling.cubic
            )
            
            cmap = mcolors.LinearSegmentedColormap.from_list(f"cmap_{layer_id}", cfg["colors"])
            norm = mcolors.Normalize(vmin=cfg["vmin"], vmax=cfg["vmax"])
            
            rgba_img = cmap(norm(data))
            
            mask = cfg["mask_func"](data)
            rgba_img[~mask, 3] = 0.0  
            rgba_img[mask, 3] = 1.0   
            
            plt.imsave(out_path, rgba_img)
            print(f"  [УСПЕХ] Файл сохранен -> {cfg['output']}")
            
    except Exception as e:
        print(f"  [ОШИБКА] Не удалось обработать {layer_id}: {e}")

print("\n=== ГЕНЕРАЦИЯ ЗАВЕРШЕНА ===")
print(f"Проверьте директорию: {OUTPUT_DIR}")