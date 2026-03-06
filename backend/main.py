import os
import rasterio
import requests
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from groq import Groq

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TIF_PATHS = {
    "light": "../data/crimea_light.tif",
    "heat": "../data/crimea_heat.tif",
    "no2": "../data/crimea_no2.tif",
    "noise": "../data/crimea_noise.tif"
}

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

def get_raster_value(lat: float, lon: float, map_type: str):
    tif_path = TIF_PATHS.get(map_type)
    if not tif_path or not os.path.exists(tif_path):
        return None
    try:
        with rasterio.open(tif_path) as src:
            row, col = src.index(lon, lat)
            val = src.read(1)[row, col]
            return max(0, float(val))
    except Exception:
        return None

def get_location_info(lat, lon):
    ""
    loc_info = {"name": "Крым (неуказанный район)", "type": "default"}
    
    try:
        overpass_url = "http://overpass-api.de/api/interpreter"
        query = f""
        op_res = requests.post(overpass_url, data={'data': query}, timeout=3)
        if op_res.status_code == 200:
            elements = op_res.json().get("elements", [])
            for el in elements:
                tags = el.get("tags", {})
                if "name" in tags:
                    name = tags["name"]
                    if "leisure" in tags and tags["leisure"] in ["park", "garden", "nature_reserve"]:
                        loc_info = {"name": f"Парковая зона '{name}'", "type": "park"}
                        break
                    elif "amenity" in tags and tags["amenity"] in ["hospital", "clinic"]:
                        loc_info = {"name": f"Медицинское учреждение '{name}'", "type": "hospital"}
                        break
                    elif "amenity" in tags and tags["amenity"] in ["school", "university"]:
                        loc_info = {"name": f"Учебное заведение '{name}'", "type": "school"}
                        break
                    elif "building" in tags and tags["building"] in ["residential", "apartments"]:
                        loc_info = {"name": f"Жилая застройка '{name}'", "type": "residential"}
                        break
                    else:
                        loc_info["name"] = name
    except Exception:
        pass

    if loc_info["type"] == "default":
        try:
            url = f"https://nominatim.openstreetmap.org/reverse?format=json&lat={lat}&lon={lon}&zoom=14&addressdetails=1"
            headers = {"User-Agent": "CrimeaExposomeHealthTech/2.0"}
            response = requests.get(url, headers=headers, timeout=3)
            data = response.json()
            address = data.get("address", {})
            city = address.get("city") or address.get("town") or address.get("village") or address.get("suburb")
            if city: loc_info["name"] = city
        except Exception:
            pass
            
    return loc_info

def generate_ai_assessment(prompt: str) -> str:
    if not client: return "Системная ошибка: Не настроен API-ключ."
    try:
        chat_completion = client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            model="llama-3.3-70b-versatile",
            temperature=0.4,
            max_tokens=300
        )
        return chat_completion.choices[0].message.content
    except Exception as e:
        return f"Ошибка ИИ: {str(e)}"

@app.get("/api/analyze-single")
def analyze_single_factor(lat: float, lon: float, map_type: str = Query(..., regex="^(light|heat|no2|noise)$")):
    raw_val = get_raster_value(lat, lon, map_type)
    if raw_val is None: return {"error": "Координаты вне зоны покрытия."}
    
    loc_info = get_location_info(lat, lon)
    zone_type = loc_info["type"]
    
    layer_info = {}
    
    if map_type == "heat":
        layer_info = {
            "name": "Температура поверхности (LST)",
            "unit": "°C",
            "val": round(raw_val, 1),
            "norm": "СанПиН не регламентирует LST. Зона комфорта: 20-25°C."
        }
    
    elif map_type == "no2":
        t_heat = get_raster_value(lat, lon, "heat")
        t_surf = (t_heat + 273.15) if t_heat else 298.15
        p_surf = 101325
        m_no2 = 46000
        r = 8.314
        omega_mol = raw_val / 1000000.0
        ratio = 0.001
        
        c_surf_mg_m3 = omega_mol * ratio * (p_surf * m_no2) / (r * t_surf)
        
        layer_info = {
            "name": "Диоксид азота (NO₂), приземный слой",
            "unit": "мг/м³",
            "val": round(c_surf_mg_m3, 3),
            "norm": "СанПиН 1.2.3685-21: ПДКм.р. = 0.2 мг/м³, ПДКс.с. = 0.04 мг/м³."
        }
        
    elif map_type == "noise":
        norm_txt = "55 дБА (день) / 45 дБА (ночь)"
        if zone_type == "hospital": norm_txt = "45 дБА (день) / 35 дБА (ночь) - территория больниц"
        elif zone_type == "park": norm_txt = "50 дБА - зоны отдыха"
        
        layer_info = {
            "name": "Акустический шум",
            "unit": "дБА",
            "val": round(raw_val, 1),
            "norm": f"СанПиН 1.2.3685-21: {norm_txt}."
        }
        
    elif map_type == "light":
        norm_txt = "Ориентир < 30 nW/cm²/sr (~5-10 Лк для жилых окон)"
        if zone_type == "park": norm_txt = "Ориентир < 15 nW/cm²/sr (зона рекреации)"
        
        layer_info = {
            "name": "Световое загрязнение",
            "unit": "nW/cm²/sr",
            "val": round(raw_val, 2),
            "norm": norm_txt
        }
    
    prompt = f""
    
    doctor_note = generate_ai_assessment(prompt)

    return {
        "coordinates": {"lat": lat, "lon": lon},
        "location_name": loc_info["name"],
        "factor": layer_info["name"],
        "value": layer_info["val"],
        "unit": layer_info["unit"],
        "norm": layer_info["norm"],
        "analysis": doctor_note
    }

@app.get("/api/analyze-complex")
def analyze_complex(lat: float, lon: float):
    light_val = get_raster_value(lat, lon, "light")
    heat_val = get_raster_value(lat, lon, "heat")
    raw_no2 = get_raster_value(lat, lon, "no2")
    noise_val = get_raster_value(lat, lon, "noise")
    
    c_surf_mg_m3 = 0
    if raw_no2 is not None:
        t_surf = (heat_val + 273.15) if heat_val else 298.15
        c_surf_mg_m3 = (raw_no2 / 1000000.0) * 0.001 * (101325 * 46000) / (8.314 * t_surf)
    
    loc_info = get_location_info(lat, lon)
    
    prompt = f""
    
    complex_analysis = generate_ai_assessment(prompt)
    
    return {
        "location_name": loc_info["name"],
        "conclusion": complex_analysis
    }