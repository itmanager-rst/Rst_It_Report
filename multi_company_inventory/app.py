import os
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from google.cloud import bigquery
from dotenv import load_dotenv

load_dotenv()

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "multi-compan-inventory").strip()
DATASET_ID = "multi_company_inventory"

app = FastAPI(title="Multi-Company Inventory API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_bigquery_client():
    try:
        return bigquery.Client(project=PROJECT_ID)
    except Exception as exc:
        print(f"⚠️ BigQuery client init failed: {exc}")
        return None


client = get_bigquery_client()


@app.get("/", response_class=HTMLResponse)
def serve_dashboard():
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "project_id": PROJECT_ID,
        "bigquery_ready": client is not None,
        "dataset": DATASET_ID,
    }


@app.get("/api/inventory")
def get_inventory(company_id: str = Query("ALL", description="ASIA, ROBOTICS, RUAMSINTHAI หรือ ALL")):
    if client is None:
        raise HTTPException(
            status_code=503,
            detail=f"BigQuery client unavailable. Check GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID='{PROJECT_ID}'.",
        )

    where_clause = ""
    if company_id != "ALL":
        where_clause = f"WHERE UPPER(b.company_id) = '{company_id.upper()}'"

    # แก้ไขโดยดึง b.wh_cd มาใช้ทั้ง wh_cd และ wh_des เพื่อป้องกัน 400 Error
    query = f"""
        SELECT 
            b.company_id,
            b.company_code,
            b.prod_cd,
            COALESCE(NULLIF(TRIM(CAST(m.prod_des AS STRING)), ''), b.prod_cd) AS prod_des,
            COALESCE(NULLIF(TRIM(CAST(m.size_des AS STRING)), ''), '') AS size_des,
            COALESCE(NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''), '-') AS wh_cd,
            COALESCE(NULLIF(TRIM(CAST(b.wh_cd AS STRING)), ''), '-') AS wh_des,
            b.bal_qty,
            b.updated_at
        FROM `{PROJECT_ID}.{DATASET_ID}.inventory_balance` b
        LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.master_products` m
            ON b.company_id = m.company_id AND b.prod_cd = m.prod_cd
        {where_clause}
        ORDER BY b.company_id, b.prod_cd
    """

    try:
        query_job = client.query(query)
        results = query_job.result()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BigQuery query failed: {exc}") from exc

    data = []
    for row in results:
        data.append({
            "company_id": row.company_id,
            "company_code": row.company_code,
            "prod_cd": row.prod_cd,
            "prod_des": row.prod_des,
            "size_des": row.size_des,
            "wh_cd": row.wh_cd,
            "wh_des": row.wh_des,
            "bal_qty": float(row.bal_qty) if row.bal_qty is not None else 0.0,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None
        })

    return {"total": len(data), "items": data}