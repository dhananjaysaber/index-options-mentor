"""Owned broker stops; acknowledgements never prove protection or cancellation."""
import hashlib
import json
import uuid
from orders import TERMINAL, encoded
from planner import decimal

class Protection:
    def __init__(self, execution):
        self.execution,self.orders=execution,execution.orders
        with self.orders.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS live_stop_actions (
                id TEXT PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL,
                request TEXT NOT NULL, state TEXT NOT NULL)''')
    def book(self, intent_id):
        current=self.orders.reconcile(intent_id); payload=json.loads(current['payload'])
        if not current['parent_id'] or payload['type']!=4: raise ValueError('NOT_OWNED_PROTECTION')
        matches=self.orders.broker.orders_by_tag('1:'+current['tag'])
        if len(matches)!=1: raise ValueError('PROTECTION_NOT_CONFIRMED')
        book=matches[0]
        if (book.get('id')!=current['broker_id'] or book.get('type')!=4 or
                book.get('symbol')!=payload['symbol'] or book.get('qty')!=payload['qty'] or
                book.get('side')!=-1 or book.get('productType')!='INTRADAY'):
            raise ValueError('BROKER_PROTECTION_MISMATCH')
        return current,book
    def ensure(self, entry_id, stop, limit, quantity):
        self.execution.owner(); entry=self.orders.reconcile(entry_id)
        contract=self.execution.planner.validate_contract(json.loads(entry['payload'])['symbol'])
        tick=decimal(contract['tick_size'])
        if (type(quantity) is not int or quantity<=0 or quantity%contract['lot_size'] or
                decimal(stop)%tick or decimal(limit)%tick or not 0<decimal(limit)<decimal(stop)):
            raise ValueError('INVALID_PROTECTION_PRICES_OR_QUANTITY')
        key=str(uuid.uuid5(uuid.NAMESPACE_URL,'iom-stop:'+entry_id))
        if not self.orders.get(key): self.orders.submit_protection(key,entry_id,stop,limit,quantity)
        row,book=self.book(key)
        if row['state']=='PENDING' and not row['filled_qty']:
            if decimal(book.get('stopPrice'))!=decimal(stop) or decimal(book.get('limitPrice'))!=decimal(limit):raise ValueError('BROKER_PROTECTION_PRICE_MISMATCH')
            return {'intentId':key,'state':'PROTECTION_CONFIRMED','stopPrice':book.get('stopPrice')}
        return {'intentId':key,'state':row['state']}
    def _reserve(self,target,kind,request):
        text=encoded(request); action=hashlib.sha256((target+':'+kind+':'+text).encode()).hexdigest()
        with self.orders.transaction() as db:
            prior=db.execute('SELECT * FROM live_stop_actions WHERE id=?',(action,)).fetchone()
            if prior: return dict(prior),False
            if kind!='CANCEL' and db.execute("SELECT 1 FROM live_stop_actions WHERE target=? AND state!='CONFIRMED'",(target,)).fetchone():
                raise ValueError('PROTECTION_CHANGE_UNRESOLVED')
            db.execute('INSERT INTO live_stop_actions VALUES (?,?,?,?,?)',(action,target,kind,text,'SUBMITTING'))
            return {'id':action,'state':'SUBMITTING'},True
    def _state(self,action,state):
        with self.orders.transaction() as db: db.execute('UPDATE live_stop_actions SET state=? WHERE id=?',(state,action))
    def cancel(self, intent_id):
        self.execution.owner(); row,book=self.book(intent_id)
        if row['state'] in TERMINAL:
            with self.orders.transaction() as db: db.execute("UPDATE live_stop_actions SET state='CONFIRMED' WHERE target=?",(intent_id,))
            return row
        action,send=self._reserve(intent_id,'CANCEL',{'brokerId':row['broker_id']})
        if send:
            try:
                result=self.orders.broker.cancel_order(row['broker_id'])
                self._state(action['id'],'ACKNOWLEDGED' if result.get('s')=='ok' else 'UNKNOWN')
            except Exception: self._state(action['id'],'UNKNOWN')
        row,book=self.book(intent_id)
        if row['state'] in TERMINAL:
            self._state(action['id'],'CONFIRMED'); return row
        raise ValueError('CANCELLATION_NOT_CONFIRMED')
    def tighten(self, intent_id, stop, limit):
        self.execution.owner(); row,book=self.book(intent_id)
        if row['state']!='PENDING' or row['filled_qty']: raise ValueError('PROTECTION_NOT_MODIFIABLE')
        payload=json.loads(row['payload']); tick=decimal(self.execution.planner.validate_contract(payload['symbol'])['tick_size'])
        stop,limit=decimal(stop),decimal(limit)
        if stop%tick or limit%tick or not 0<limit<stop: raise ValueError('INVALID_PROTECTION_PRICE')
        existing=decimal(book.get('stopPrice'))
        if stop<existing: raise ValueError('PROTECTION_CANNOT_LOOSEN')
        request={'id':row['broker_id'],'stopPrice':float(stop),'limitPrice':float(limit),'qty':payload['qty']}
        if stop==existing and decimal(book.get('limitPrice'))==limit:
            with self.orders.transaction() as db:
                db.execute("UPDATE live_stop_actions SET state='CONFIRMED' WHERE target=? AND kind='MODIFY' AND request=?",(intent_id,encoded(request)))
            return {'state':'PROTECTION_CONFIRMED','stopPrice':float(stop)}
        action,send=self._reserve(intent_id,'MODIFY',request)
        if send:
            try:
                result=self.orders.broker.modify_stop(row['broker_id'],float(stop),float(limit),payload['qty'])
                self._state(action['id'],'ACKNOWLEDGED' if result.get('s')=='ok' else 'UNKNOWN')
            except Exception: self._state(action['id'],'UNKNOWN')
        row,book=self.book(intent_id)
        if (row['state']=='PENDING' and not row['filled_qty'] and decimal(book.get('stopPrice'))==stop and decimal(book.get('limitPrice'))==limit):
            self._state(action['id'],'CONFIRMED'); return {'state':'PROTECTION_CONFIRMED','stopPrice':float(stop)}
        raise ValueError('PROTECTION_MODIFICATION_NOT_CONFIRMED')
