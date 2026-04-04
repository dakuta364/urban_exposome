import math
import os
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict

import rasterio
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from groq import Groq

load_dotenv()


# --- App setup ---
app = FastAPI(title="Urban Exposome Backend", version="2.0.0")
APP_STARTED_AT = time.time()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Configuration ---
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"

TIF_PATHS = {
    "light": DATA_DIR / "crimea_light.tif",
    "heat": DATA_DIR / "crimea_heat.tif",
    "no2": DATA_DIR / "crimea_no2.tif",
    "noise": DATA_DIR / "crimea_noise.tif",
}

MAP_TYPE_PATTERN = "^(light|heat|no2|noise)$"

CRIMEA_BOUNDS = {
    "lat_min": 44.37708309,
    "lat_max": 46.23124977,
    "lon_min": 32.48125074,
    "lon_max": 36.63958411,
}


def env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


DEMO_MODE = env_flag("DEMO_MODE", True)
ENABLE_OSM_LOOKUP = env_flag("ENABLE_OSM_LOOKUP", not DEMO_MODE)
ENABLE_LLM = env_flag("ENABLE_LLM", True)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
client = Groq(api_key=GROQ_API_KEY) if (GROQ_API_KEY and ENABLE_LLM) else None


# --- Core data helpers ---
@lru_cache(maxsize=8)
def get_raster_dataset(map_type: str):
    path = TIF_PATHS.get(map_type)
    if not path or not path.exists():
        return None
    return rasterio.open(path)


def get_raster_value(lat: float, lon: float, map_type: str):
    ds = get_raster_dataset(map_type)
    if ds is None:
        return None

    if not (ds.bounds.left <= lon <= ds.bounds.right and ds.bounds.bottom <= lat <= ds.bounds.top):
        return None

    try:
        value = float(next(ds.sample([(lon, lat)]))[0])
    except Exception:
        return None

    if ds.nodata is not None and value == ds.nodata:
        return None
    if math.isnan(value):
        return None
    return max(0.0, value)


def convert_no2_raw_to_surface(raw_no2: float, heat_celsius: float | None) -> float:
    t_surf = (heat_celsius + 273.15) if heat_celsius is not None else 298.15
    p_surf = 101325
    m_no2 = 46000
    r = 8.314

    omega_mol = raw_no2 / 1_000_000.0
    ratio = 0.001
    c_surf_mg_m3 = omega_mol * ratio * (p_surf * m_no2) / (r * t_surf)
    return max(0.0, float(c_surf_mg_m3))


def get_demo_location_name(lat: float, lon: float) -> str:
    lat_mid = (CRIMEA_BOUNDS["lat_min"] + CRIMEA_BOUNDS["lat_max"]) / 2
    lon_mid = (CRIMEA_BOUNDS["lon_min"] + CRIMEA_BOUNDS["lon_max"]) / 2

    lat_label = "север" if lat >= lat_mid else "юг"
    lon_label = "восток" if lon >= lon_mid else "запад"
    return f"Крым, сектор {lat_label}-{lon_label} ({lat:.4f}, {lon:.4f})"


def get_location_info(lat: float, lon: float) -> Dict[str, str]:
    fallback = {
        "name": get_demo_location_name(lat, lon),
        "type": "default",
        "source": "demo" if DEMO_MODE else "fallback",
    }

    if DEMO_MODE or not ENABLE_OSM_LOOKUP:
        return fallback

    loc_info = dict(fallback)
    loc_info["source"] = "osm"

    try:
        overpass_url = "https://overpass-api.de/api/interpreter"
        query = f"""
        [out:json][timeout:3];
        (
          way(around:50, {lat}, {lon})["leisure"];
          way(around:50, {lat}, {lon})["amenity"];
          way(around:50, {lat}, {lon})["building"];
          way(around:50, {lat}, {lon})["tourism"];
        );
        out tags;
        """
        op_res = requests.post(overpass_url, data={"data": query}, timeout=3)
        if op_res.status_code == 200:
            elements = op_res.json().get("elements", [])
            for el in elements:
                tags = el.get("tags", {})
                name = tags.get("name")
                if not name:
                    continue

                if tags.get("leisure") in {"park", "garden", "nature_reserve"}:
                    return {"name": f"Парковая зона '{name}'", "type": "park", "source": "osm"}
                if tags.get("amenity") in {"hospital", "clinic"}:
                    return {"name": f"Социальный объект '{name}'", "type": "hospital", "source": "osm"}
                if tags.get("amenity") in {"school", "university"}:
                    return {"name": f"Учебная зона '{name}'", "type": "school", "source": "osm"}
                if tags.get("building") in {"residential", "apartments"}:
                    return {"name": f"Жилая застройка '{name}'", "type": "residential", "source": "osm"}

                return {"name": name, "type": "default", "source": "osm"}
    except Exception:
        pass

    try:
        headers = {"User-Agent": "UrbanExposomeDemo/2.0"}
        url = (
            "https://nominatim.openstreetmap.org/reverse"
            f"?format=json&lat={lat}&lon={lon}&zoom=14&addressdetails=1"
        )
        response = requests.get(url, headers=headers, timeout=3)
        data = response.json()
        address = data.get("address", {})
        city = address.get("city") or address.get("town") or address.get("village") or address.get("suburb")
        if city:
            return {"name": city, "type": "default", "source": "nominatim"}
    except Exception:
        pass

    return fallback


def no2_norm_text() -> str:
    return "СанПиН 1.2.3685-21: ПДКм.р. = 0.2 мг/м³, ПДКс.с. = 0.04 мг/м³."


def classify_single_factor(map_type: str, value: float, zone_type: str = "default") -> Dict[str, str]:
    if map_type == "heat":
        if value <= 25:
            return {
                "level": "низкий",
                "text": "Температурный фон близок к зоне термокомфорта, выраженная тепловая нагрузка по этой точке не ожидается.",
            }
        if value <= 30:
            return {
                "level": "умеренный",
                "text": "Наблюдается умеренный перегрев поверхности. В жаркие часы возможно усиление теплового стресса в уличной среде.",
            }
        if value <= 35:
            return {
                "level": "повышенный",
                "text": "Фиксируется тепловой остров. Вероятно увеличение физиологической нагрузки, особенно при длительном пребывании на открытом воздухе.",
            }
        return {
            "level": "высокий",
            "text": "Выраженный перегрев поверхности указывает на неблагоприятный микроклимат с повышенным риском теплового перенапряжения.",
        }

    if map_type == "no2":
        if value <= 0.04:
            return {
                "level": "низкий",
                "text": "Оценка по NO₂ находится в пределах среднесуточного ориентира; выраженного ингаляционного риска по этому фактору не видно.",
            }
        if value <= 0.2:
            return {
                "level": "повышенный",
                "text": "Концентрация выше среднесуточного ориентира и требует скринингового внимания: возможна хроническая респираторная нагрузка.",
            }
        return {
            "level": "высокий",
            "text": "Концентрация сопоставима с диапазоном острых эпизодов загрязнения. Точка относится к зоне неблагоприятного атмосферного фона.",
        }

    if map_type == "noise":
        day_norm = 55
        if zone_type == "hospital":
            day_norm = 45
        elif zone_type == "park":
            day_norm = 50

        if value <= day_norm:
            return {
                "level": "низкий",
                "text": "Шумовой фон не выходит за ориентир для данного типа территории и считается приемлемым для скрининговой оценки.",
            }
        if value <= day_norm + 10:
            return {
                "level": "умеренный",
                "text": "Отмечается превышение ориентировочного уровня шума. Вероятна дополнительная нейрофизиологическая нагрузка при длительной экспозиции.",
            }
        return {
            "level": "высокий",
            "text": "Уровень шума существенно выше ориентира, что соответствует неблагоприятной акустической среде.",
        }

    if map_type == "light":
        norm = 15 if zone_type == "park" else 30
        if value <= norm:
            return {
                "level": "низкий",
                "text": "Световое загрязнение находится в безопасном диапазоне для ночной среды и циркадного ритма.",
            }
        if value <= norm * 2:
            return {
                "level": "умеренный",
                "text": "Ночной световой фон повышен: возможна умеренная циркадная десинхронизация в чувствительных группах.",
            }
        return {
            "level": "высокий",
            "text": "Световая экспозиция выраженно повышена, что характерно для зон с потенциально неблагоприятным ночным световым режимом.",
        }

    return {
        "level": "не определен",
        "text": "Для выбранного фактора пока нет детерминированной интерпретации.",
    }


def score_complex(light_val: float, heat_val: float, no2_val: float, noise_val: float) -> Dict[str, Any]:
    light_score = 0 if light_val <= 30 else (1 if light_val <= 60 else 2)
    heat_score = 0 if heat_val <= 25 else (1 if heat_val <= 30 else 2)
    no2_score = 0 if no2_val <= 0.04 else (1 if no2_val <= 0.2 else 2)
    noise_score = 0 if noise_val <= 55 else (1 if noise_val <= 65 else 2)

    total = light_score + heat_score + no2_score + noise_score

    if total <= 2:
        level = "низкий"
    elif total <= 5:
        level = "умеренный"
    else:
        level = "высокий"

    links = []
    if heat_score >= 1 and no2_score >= 1:
        links.append("тепловой фон и NO₂ могут усиливать фотохимическую нагрузку воздуха")
    if noise_score >= 1 and light_score >= 1:
        links.append("шум и ночная засветка повышают риск нейроэндокринного стресса")

    if links:
        synergy = "; ".join(links)
    else:
        synergy = "комбинация факторов близка к фоновому уровню для скрининговой оценки"

    text = (
        f"Суммарный уровень экологической нагрузки: {level}. "
        f"В этой точке {synergy}. "
        "Вывод носит скрининговый характер и предназначен для приоритизации дальнейшего мониторинга."
    )

    return {
        "level": level,
        "text": text,
        "scores": {
            "light": light_score,
            "heat": heat_score,
            "no2": no2_score,
            "noise": noise_score,
            "total": total,
        },
    }


def generate_ai_assessment(prompt: str) -> str:
    if not client:
        return "LLM недоступен: API-ключ не задан или режим LLM отключен."

    try:
        chat_completion = client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            model="llama-3.3-70b-versatile",
            temperature=0.25,
            max_tokens=220,
        )
        return chat_completion.choices[0].message.content
    except Exception as exc:
        return f"Ошибка LLM: {exc}"


def build_single_analysis(lat: float, lon: float, map_type: str) -> Dict[str, Any]:
    raw_val = get_raster_value(lat, lon, map_type)
    if raw_val is None:
        return {"error": "Координаты вне зоны покрытия."}

    loc_info = get_location_info(lat, lon)
    zone_type = loc_info["type"]

    if map_type == "heat":
        final_val = round(raw_val, 1)
        layer_info = {
            "name": "Температура поверхности (LST)",
            "unit": "°C",
            "norm": "СанПиН не регламентирует LST напрямую. Скрининговый ориентир микроклимата: 20-25°C.",
        }
    elif map_type == "no2":
        heat_for_no2 = get_raster_value(lat, lon, "heat")
        final_val = round(convert_no2_raw_to_surface(raw_val, heat_for_no2), 3)
        layer_info = {
            "name": "Диоксид азота (NO₂), приземный слой",
            "unit": "мг/м³",
            "norm": no2_norm_text(),
        }
    elif map_type == "noise":
        norm_txt = "55 дБА (день) / 45 дБА (ночь)"
        if zone_type == "hospital":
            norm_txt = "45 дБА (день) / 35 дБА (ночь)"
        elif zone_type == "park":
            norm_txt = "50 дБА"

        final_val = round(raw_val, 1)
        layer_info = {
            "name": "Акустический шум",
            "unit": "дБА",
            "norm": f"СанПиН 1.2.3685-21: {norm_txt}.",
        }
    else:  # light
        norm_txt = "Ориентир < 30 nW/cm²/sr (~5-10 Лк для жилых окон)"
        if zone_type == "park":
            norm_txt = "Ориентир < 15 nW/cm²/sr (зона рекреации)"

        final_val = round(raw_val, 2)
        layer_info = {
            "name": "Световое загрязнение",
            "unit": "nW/cm²/sr",
            "norm": norm_txt,
        }

    screening = classify_single_factor(map_type, float(final_val), zone_type)

    return {
        "coordinates": {"lat": lat, "lon": lon},
        "location_name": loc_info["name"],
        "location_source": loc_info.get("source", "unknown"),
        "factor": layer_info["name"],
        "value": final_val,
        "unit": layer_info["unit"],
        "norm": layer_info["norm"],
        "analysis": screening["text"],
        "screening_level": screening["level"],
        "analysis_mode": "deterministic",
        "llm_available": client is not None,
        "demo_mode": DEMO_MODE,
        "map_type": map_type,
    }


def build_complex_analysis(lat: float, lon: float) -> Dict[str, Any]:
    light_val = get_raster_value(lat, lon, "light")
    heat_val = get_raster_value(lat, lon, "heat")
    raw_no2 = get_raster_value(lat, lon, "no2")
    noise_val = get_raster_value(lat, lon, "noise")

    if any(v is None for v in [light_val, heat_val, raw_no2, noise_val]):
        return {"error": "Координаты вне зоны покрытия."}

    no2_val = convert_no2_raw_to_surface(raw_no2, heat_val)
    loc_info = get_location_info(lat, lon)
    score = score_complex(light_val, heat_val, no2_val, noise_val)

    return {
        "location_name": loc_info["name"],
        "location_source": loc_info.get("source", "unknown"),
        "conclusion": score["text"],
        "screening_level": score["level"],
        "analysis_mode": "deterministic",
        "llm_available": client is not None,
        "demo_mode": DEMO_MODE,
        "factors": {
            "heat_c": round(heat_val, 1),
            "no2_mg_m3": round(no2_val, 3),
            "noise_dba": round(noise_val, 1),
            "light_nw": round(light_val, 2),
        },
        "scores": score["scores"],
    }


# --- Service readiness ---
def get_backend_status() -> Dict[str, Any]:
    raster_layers = {}
    raster_ok = True

    for key, path in TIF_PATHS.items():
        exists = path.exists()
        opened = False
        if exists:
            opened = get_raster_dataset(key) is not None
        raster_layers[key] = {
            "path": str(path),
            "exists": exists,
            "opened": opened,
        }
        raster_ok = raster_ok and exists and opened

    return {
        "ok": raster_ok,
        "service": "urban-exposome-backend",
        "utc_time": datetime.now(timezone.utc).isoformat(),
        "uptime_seconds": round(time.time() - APP_STARTED_AT, 1),
        "demo_mode": DEMO_MODE,
        "osm_lookup_enabled": ENABLE_OSM_LOOKUP and not DEMO_MODE,
        "llm_available": client is not None,
        "raster_layers": raster_layers,
    }


@app.get("/healthz")
def healthz():
    return get_backend_status()


@app.get("/ready")
def ready():
    status = get_backend_status()
    if status["ok"]:
        return status
    return JSONResponse(status_code=503, content=status)


# --- API endpoints ---
@app.get("/api/analyze-single")
def analyze_single_factor(
    lat: float,
    lon: float,
    map_type: str = Query(..., pattern=MAP_TYPE_PATTERN),
):
    return build_single_analysis(lat, lon, map_type)


@app.get("/api/analyze-single-advanced")
def analyze_single_advanced(
    lat: float,
    lon: float,
    map_type: str = Query(..., pattern=MAP_TYPE_PATTERN),
):
    base = build_single_analysis(lat, lon, map_type)
    if "error" in base:
        return base

    if not client:
        return {
            **base,
            "analysis_mode": "deterministic",
            "advanced_error": "LLM-интерпретация недоступна: ключ API не настроен или LLM отключен.",
        }

    prompt = (
        "Ты эксперт по гигиене окружающей среды и пространственной эпидемиологии. "
        f"Локация: {base['location_name']}. "
        f"Фактор: {base['factor']}. Значение: {base['value']} {base['unit']}. "
        f"Норматив: {base['norm']}. "
        "Сформулируй краткую расширенную научную интерпретацию (до 90 слов), "
        "без клинических диагнозов и без бытовых советов."
    )

    llm_text = generate_ai_assessment(prompt)
    return {
        **base,
        "analysis": llm_text,
        "analysis_mode": "llm",
        "base_analysis": base["analysis"],
    }


@app.get("/api/analyze-complex")
def analyze_complex(lat: float, lon: float):
    return build_complex_analysis(lat, lon)


@app.get("/api/analyze-complex-advanced")
def analyze_complex_advanced(lat: float, lon: float):
    base = build_complex_analysis(lat, lon)
    if "error" in base:
        return base

    if not client:
        return {
            **base,
            "analysis_mode": "deterministic",
            "advanced_error": "LLM-интерпретация недоступна: ключ API не настроен или LLM отключен.",
        }

    factors = base["factors"]
    prompt = (
        "Ты эксперт по пространственной эпидемиологии. "
        f"Локация: {base['location_name']}. "
        f"LST={factors['heat_c']} °C, NO2={factors['no2_mg_m3']} мг/м³, "
        f"Шум={factors['noise_dba']} дБА, Свет={factors['light_nw']} nW/cm²/sr. "
        "Дай расширенную научную интерпретацию синергетического влияния факторов (до 120 слов), "
        "без клинических диагнозов и рекомендаций по лечению."
    )

    llm_text = generate_ai_assessment(prompt)
    return {
        **base,
        "conclusion": llm_text,
        "analysis_mode": "llm",
        "base_conclusion": base["conclusion"],
    }
