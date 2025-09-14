import base64, json, logging, os, time
from typing import Any, Dict, List
from decimal import Decimal
import boto3

logger = logging.getLogger(); logger.setLevel(logging.INFO)
TABLE_NAME = os.environ["TABLE_NAME"]
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)

def _parse_body(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "body" not in event or not event["body"]:
        return []
    raw = base64.b64decode(event["body"]).decode("utf-8") if event.get("isBase64Encoded") else event["body"]
    # ✅ Parse floats as Decimal so DynamoDB accepts them
    payload = json.loads(raw, parse_float=Decimal, parse_int=Decimal)
    if not isinstance(payload, list):
        raise ValueError("Body must be a JSON array of records")
    return payload

def save_to_db(records: List[Dict[str, Any]]):
    now = int(time.time()); ttl = now + 24*3600
    # ✅ remove unsupported arg
    with table.batch_writer() as batch:
        for r in records:
            if not isinstance(r, dict) or "record_id" not in r:
                raise ValueError("Each record must be an object with 'record_id'")
            item = dict(r)
            item.setdefault("createdAt", now)
            item["expiresAt"] = ttl
            batch.put_item(Item=item)

def _response(status: int, body: Dict[str, Any]):
    return {"isBase64Encoded": False, "statusCode": status,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(body)}

def lambda_handler(event, context):
    try:
        records = _parse_body(event)
        if not records:
            return _response(400, {"errorMessage": "Request body is empty or invalid"})
        save_to_db(records)
        return _response(200, {"message": "Saved", "count": len(records)})
    except ValueError as ve:
        logger.warning("Validation failed: %s", ve)
        return _response(400, {"errorMessage": str(ve)})
    except Exception:
        logger.exception("Unexpected error")
        return _response(500, {"errorMessage": "Internal server error"})