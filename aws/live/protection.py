"""Owned broker stops; acknowledgements never prove protection or cancellation."""
import hashlib
import json
import uuid
from orders import REFUSALS, TERMINAL, encoded
from planner import decimal

# Seconds before an unconfirmed cancel or a refused change may be sent again,
# and before an unconfirmed stop change stops blocking newer ones.
RESEND_AFTER, ABANDON_AFTER = 5, 10

class Protection:
    def __init__(self, execution):
        self.execution,self.orders=execution,execution.orders
        with self.orders.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS live_stop_actions (
                id TEXT PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL,
                request TEXT NOT NULL, state TEXT NOT NULL)''')
            # Send times live in their own table: the older version writes the
            # table above by position, so a rollback needs it to stay unchanged.
            db.execute('CREATE TABLE IF NOT EXISTS live_stop_times (id TEXT PRIMARY KEY, sent_at REAL NOT NULL)')
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
    @staticmethod
    def key(entry_id, attempt=1):
        return str(uuid.uuid5(uuid.NAMESPACE_URL,'iom-stop:'+entry_id+('' if attempt==1 else ':'+str(attempt))))
    def ensure(self, entry_id, stop, limit, quantity, key=None):
        self.execution.owner(); entry=self.orders.reconcile(entry_id)
        contract=self.execution.planner.validate_contract(json.loads(entry['payload'])['symbol'])
        tick=decimal(contract['tick_size'])
        if (type(quantity) is not int or quantity<=0 or quantity%contract['lot_size'] or
                decimal(stop)%tick or decimal(limit)%tick or not 0<decimal(limit)<decimal(stop)):
            raise ValueError('INVALID_PROTECTION_PRICES_OR_QUANTITY')
        key=key or self.key(entry_id)
        if not self.orders.get(key):
            # With buying off, send a new stop only for a trade FYERS still holds.
            if self.orders.enabled is not True: self.execution.check_holding(json.loads(entry['payload'])['symbol'])
            self.orders.submit_protection(key,entry_id,stop,limit,quantity)
        row,book=self.book(key)
        if row['state']=='PENDING' and not row['filled_qty']:
            if decimal(book.get('stopPrice'))!=decimal(stop) or decimal(book.get('limitPrice'))!=decimal(limit):raise ValueError('BROKER_PROTECTION_PRICE_MISMATCH')
            return {'intentId':key,'state':'PROTECTION_CONFIRMED','stopPrice':book.get('stopPrice')}
        return {'intentId':key,'state':row['state']}
    def _reserve(self,target,kind,request):
        text=encoded(request); action=hashlib.sha256((target+':'+kind+':'+text).encode()).hexdigest()
        now=self.execution.planner.clock()
        with self.orders.transaction() as db:
            prior=db.execute('''SELECT a.*,COALESCE(t.sent_at,0) AS sent_at FROM live_stop_actions a
                LEFT JOIN live_stop_times t ON t.id=a.id WHERE a.id=?''',(action,)).fetchone()
            if prior:
                # Cancelling twice cannot create exposure. A change is repeated
                # only when the broker refused it or it was given up on.
                again=(prior['state']!='CONFIRMED' if kind=='CANCEL' else prior['state'] in ('REFUSED','ABANDONED'))
                if again and now-prior['sent_at']>=RESEND_AFTER:
                    db.execute("UPDATE live_stop_actions SET state='SUBMITTING' WHERE id=?",(action,))
                    db.execute('INSERT OR REPLACE INTO live_stop_times VALUES (?,?)',(action,now))
                    return {'id':action,'state':'SUBMITTING'},True
                return dict(prior),False
            if kind!='CANCEL':
                db.execute("UPDATE live_stop_actions SET state='ABANDONED' WHERE target=? AND state IN ('SUBMITTING','ACKNOWLEDGED','UNKNOWN') AND ?-COALESCE((SELECT sent_at FROM live_stop_times t WHERE t.id=live_stop_actions.id),0)>=?",(target,now,ABANDON_AFTER))
                if db.execute("SELECT 1 FROM live_stop_actions WHERE target=? AND state IN ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')",(target,)).fetchone():
                    raise ValueError('PROTECTION_CHANGE_UNRESOLVED')
            db.execute('INSERT INTO live_stop_actions(id,target,kind,request,state) VALUES (?,?,?,?,?)',(action,target,kind,text,'SUBMITTING'))
            db.execute('INSERT OR REPLACE INTO live_stop_times VALUES (?,?)',(action,now))
            return {'id':action,'state':'SUBMITTING'},True
    def cancel_exit(self, intent_id):
        """Cancel an unfilled ordinary sale so it can be replaced."""
        self.execution.owner(); row=self.orders.reconcile(intent_id)
        if row['state'] in TERMINAL: return row
        if not row['parent_id'] or not row['broker_id']: raise ValueError('EXIT_OUTCOME_UNKNOWN_CHECK_BROKER')
        action,send=self._reserve(intent_id,'CANCEL',{'brokerId':row['broker_id']})
        if send: self._send_cancel(action,row['broker_id'])
        row=self.orders.reconcile(intent_id)
        if row['state'] not in TERMINAL: raise ValueError('CANCELLATION_NOT_CONFIRMED')
        self._state(action['id'],'CONFIRMED'); return row
    def _send_cancel(self,action,broker_id):
        try:
            result=self.orders.broker.cancel_order(broker_id)
            self._state(action['id'],'ACKNOWLEDGED' if result.get('s')=='ok' else 'UNKNOWN')
        except Exception: self._state(action['id'],'UNKNOWN')
    def _state(self,action,state):
        with self.orders.transaction() as db: db.execute('UPDATE live_stop_actions SET state=? WHERE id=?',(state,action))
    def cancel(self, intent_id):
        self.execution.owner(); row,book=self.book(intent_id)
        if row['state'] in TERMINAL:
            with self.orders.transaction() as db: db.execute("UPDATE live_stop_actions SET state='CONFIRMED' WHERE target=?",(intent_id,))
            return row
        action,send=self._reserve(intent_id,'CANCEL',{'brokerId':row['broker_id']})
        if send: self._send_cancel(action,row['broker_id'])
        row,book=self.book(intent_id)
        if row['state'] in TERMINAL:
            self._state(action['id'],'CONFIRMED'); return row
        raise ValueError('CANCELLATION_NOT_CONFIRMED')
    def shrink(self, intent_id, quantity):
        """Reduce an owned stop to the quantity still held, at the same prices.

        Never increases it. Success only when the orderbook shows the new size."""
        self.execution.owner(); row,book=self.book(intent_id)
        if row['state']!='PENDING' or row['filled_qty']: raise ValueError('PROTECTION_NOT_MODIFIABLE')
        current=json.loads(row['payload'])['qty']
        if current==quantity: return True
        if type(quantity) is not int or not 0<quantity<current: raise ValueError('INVALID_PROTECTION_QUANTITY')
        now=self.execution.planner.clock()
        with self.orders.transaction() as db:
            # A price change still in flight carries the old quantity: wait for it.
            if db.execute('''SELECT 1 FROM live_stop_actions a JOIN live_stop_times t ON t.id=a.id
                    WHERE a.target=? AND a.kind='MODIFY' AND a.state IN ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')
                    AND ?-t.sent_at<?''',(intent_id,now,ABANDON_AFTER)).fetchone():
                raise ValueError('PROTECTION_CHANGE_UNRESOLVED')
            prior=db.execute('SELECT quantity,sent_at FROM live_stop_resizes WHERE id=?',(intent_id,)).fetchone()
            send=not prior or prior['quantity']!=quantity or now-prior['sent_at']>=RESEND_AFTER
            # Saved before sending, so a restart still recognises the new size.
            if send: db.execute('INSERT OR REPLACE INTO live_stop_resizes VALUES (?,?,?)',(intent_id,quantity,now))
        if send:
            try: self.orders.broker.modify_stop(row['broker_id'],float(book.get('stopPrice')),float(book.get('limitPrice')),quantity)
            except Exception: pass
        row,_=self.book(intent_id)
        if row['state']=='PENDING' and json.loads(row['payload'])['qty']==quantity: return True
        raise ValueError('PROTECTION_MODIFICATION_NOT_CONFIRMED')
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
                self._state(action['id'],'ACKNOWLEDGED' if result.get('s')=='ok' else 'REFUSED' if result.get('s')=='error' else 'UNKNOWN')
            except Exception as error: self._state(action['id'],'REFUSED' if str(error) in REFUSALS else 'UNKNOWN')
        row,book=self.book(intent_id)
        if (row['state']=='PENDING' and not row['filled_qty'] and decimal(book.get('stopPrice'))==stop and decimal(book.get('limitPrice'))==limit):
            self._state(action['id'],'CONFIRMED'); return {'state':'PROTECTION_CONFIRMED','stopPrice':float(stop)}
        raise ValueError('PROTECTION_MODIFICATION_NOT_CONFIRMED')
