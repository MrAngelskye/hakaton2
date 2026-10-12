"""MVP regressions through HTTP: publication, gardens, downloads and access failures."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import threading
import unittest
from urllib.error import HTTPError
from test_access import Client, portal


class MvpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(os.environ.get('EDU_TEST_DIR', str(Path.cwd() / 'data/tests'))).resolve()
        cls.path = cls.root / ('mvp-' + secrets.token_hex(8) + '.sqlite3')
        cls.server = portal.create_server(cls.path,port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever,kwargs={'poll_interval':0.05},daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
        for suffix in ('','-wal','-shm'):
            path = Path(str(cls.path) + suffix).resolve()
            if path.parent != cls.root:
                raise RuntimeError('Test database escaped its directory.')
            path.unlink(missing_ok=True)

    def setUp(self):
        portal.PortalHandler.failures = {}

    def client(self,login='teacher-garden',role='teacher'):
        client = Client(self.base)
        self.assertEqual(client.login(login,role)[0],200)
        return client

    def news(self,status='draft'):
        return {'orgId':'garden-sun','title':'Новость для родителей','titleKk':'Ата-аналарға арналған жаңалық',
                'summary':'Проверка публикации','summaryKk':'Жариялауды тексеру','body':'Текст новости','bodyKk':'Жаңалық мәтіні',
                'category':'Родителям','date':'2026-10-12','status':status}

    def upload(self,client,filename='notice.txt',content=b'Public demonstration document',status='draft',org='garden-sun'):
        return client.request('/api/documents','POST',{'orgId':org,'title':'Документ','titleKk':'Құжат','filename':filename,
                              'fileBase64':base64.b64encode(content).decode('ascii'),'status':status})

    def test_public_catalog_is_open_but_accounts_and_private_api_stay_closed(self):
        guest = Client(self.base)
        status,data = guest.request('/api/public/bootstrap')
        self.assertEqual(status,200)
        self.assertGreaterEqual(len(data['organizations']),12)
        self.assertTrue(any(org['type'] == 'garden' for org in data['organizations']))
        self.assertTrue(all(doc['status'] == 'published' for doc in data['documents']))
        for forbidden in ['users','csrf','sessions','audit','password_hash','salt']:
            self.assertNotIn(forbidden,data)
        self.assertEqual(guest.request('/api/users')[0],401)
        self.assertEqual(guest.request('/api/audit')[0],401)
        self.assertEqual(guest.request('/api/documents','POST',{})[0],401)

    def test_garden_fields_have_independent_translations_and_school_cannot_edit(self):
        garden = self.client()
        org = garden.request('/api/organizations/garden-sun')[1]['organization']
        updated = {**org,'ageGroups':['3–4 года'],'ageGroupsKk':['3–4 жас'],
                   'routine':'09:00 · занятия','routineKk':'09:00 · сабақтар','parentInfo':'Сведения родителям','parentInfoKk':'Ата-аналарға ақпарат'}
        self.assertEqual(garden.request('/api/organizations/garden-sun','PUT',updated)[0],200)
        school = self.client('teacher24')
        self.assertEqual(school.request('/api/organizations/garden-sun','PUT',updated)[0],403)
        public = Client(self.base).request('/api/public/organizations/garden-sun')[1]['organization']
        self.assertEqual(public['routineKk'],'09:00 · сабақтар')
        self.assertEqual(public['ageGroups'],['3–4 года'])
        self.assertEqual(garden.request('/api/organizations/garden-sun','PUT',org)[0],200)

    def test_draft_news_is_hidden_then_public_then_archived_and_restored(self):
        teacher = self.client()
        status,result = teacher.request('/api/news','POST',self.news())
        self.assertEqual(status,201)
        item = result['news']; endpoint = '/api/news/' + item['id']; public_endpoint = '/api/public/news/' + item['id']
        guest = Client(self.base)
        self.assertEqual(guest.request(public_endpoint)[0],404)
        self.assertEqual(teacher.request(endpoint)[0],200)
        student = self.client('student24','student')
        self.assertEqual(student.request(endpoint)[0],403)
        self.assertEqual(teacher.request(endpoint,'PUT',{**item,'status':'published'})[0],200)
        status,public = guest.request(public_endpoint)
        self.assertEqual(status,200); self.assertEqual(public['news']['titleKk'],self.news()['titleKk'])
        self.assertEqual(teacher.request(endpoint,'DELETE',{})[0],200)
        self.assertEqual(guest.request(public_endpoint)[0],404)
        self.assertEqual(teacher.request(endpoint)[1]['news']['status'],'archived')
        self.assertEqual(teacher.request(endpoint,'PUT',{**item,'status':'published'})[0],200)
        self.assertEqual(guest.request(public_endpoint)[0],200)

    def test_reader_does_not_see_own_school_draft(self):
        teacher = self.client('teacher24'); student = self.client('student24','student')
        status,result = teacher.request('/api/news','POST',{**self.news(),'orgId':'school-24'})
        self.assertEqual(status,201)
        self.assertEqual(student.request('/api/news/'+result['news']['id'])[0],404)
        self.assertNotIn(result['news']['id'],[item['id'] for item in student.request('/api/bootstrap')[1]['news']])

    def test_new_draft_site_is_private_until_explicit_publication(self):
        admin = self.client('admin','admin')
        sample = admin.request('/api/organizations/garden-sun')[1]['organization']
        status,result = admin.request('/api/organizations','POST',{**sample,'name':'Новый демонстрационный сад','visibility':'draft'})
        self.assertEqual(status,201); org = result['organization']
        guest = Client(self.base)
        self.assertEqual(guest.request('/api/public/organizations/'+org['id'])[0],404)
        self.assertNotIn(org['id'],[item['id'] for item in guest.request('/api/public/bootstrap')[1]['organizations']])
        self.assertEqual(admin.request('/api/organizations/'+org['id'],'PUT',{**org,'visibility':'published'})[0],200)
        self.assertEqual(guest.request('/api/public/organizations/'+org['id'])[0],200)

    def test_pdf_upload_preserves_bytes_and_hides_draft_and_archive(self):
        teacher = self.client(); content = b'%PDF-1.4\nMVP upload regression\n%%EOF\n'
        status,result = self.upload(teacher,'approved.pdf',content)
        self.assertEqual(status,201); doc = result['document']; guest = Client(self.base)
        endpoint = '/api/documents/' + doc['id']; public_endpoint = '/api/public/documents/' + doc['id']
        self.assertEqual(guest.request(public_endpoint)[0],404)
        school = self.client('teacher24'); self.assertEqual(school.request(endpoint)[0],403)
        self.assertEqual(teacher.request(endpoint,'PUT',{**doc,'status':'published'})[0],200)
        with guest.opener.open(self.base + public_endpoint) as response:
            self.assertEqual(response.read(),content)
            self.assertEqual(response.headers['Content-Type'],'application/pdf')
            self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
        self.assertEqual(teacher.request(endpoint,'DELETE',{})[0],200)
        self.assertEqual(guest.request(public_endpoint)[0],404)

    def test_document_validation_and_organization_access(self):
        teacher = self.client(); school = self.client('teacher24'); student = self.client('student24','student')
        self.assertEqual(self.upload(teacher,'program.exe')[0],400)
        self.assertEqual(self.upload(teacher,'fake.pdf',b'not a PDF')[0],400)
        self.assertEqual(self.upload(teacher,'invalid.txt',b'\xff\xfe')[0],400)
        self.assertEqual(self.upload(school)[0],403)
        self.assertEqual(self.upload(student,org='school-24')[0],403)

    def test_non_ascii_csrf_is_a_normal_denial(self):
        teacher = self.client(); org = teacher.request('/api/organizations/garden-sun')[1]['organization']
        teacher.csrf = '\u00ff'
        self.assertEqual(teacher.request('/api/organizations/garden-sun','PUT',org)[0],403)

    def test_parallel_login_limit_reserves_each_attempt(self):
        barrier = threading.Barrier(10)
        def login(_):
            client = Client(self.base); barrier.wait(timeout=5)
            return client.login('teacher-garden','teacher','WrongMvpPassword')[0]
        with ThreadPoolExecutor(max_workers=10) as executor:
            statuses = list(executor.map(login,range(10)))
        self.assertEqual(statuses.count(401),8)
        self.assertEqual(statuses.count(429),2)
        self.assertEqual(Client(self.base).login('teacher-garden','teacher','WrongMvpPassword')[0],429)

    def test_audit_is_scoped_and_does_not_include_credentials(self):
        teacher = self.client(); org = teacher.request('/api/organizations/garden-sun')[1]['organization']
        self.assertEqual(teacher.request('/api/organizations/garden-sun','PUT',org)[0],200)
        status,result = teacher.request('/api/audit'); self.assertEqual(status,200)
        self.assertTrue(result['audit']); self.assertTrue(all(event['org_id'] == 'garden-sun' for event in result['audit']))
        self.assertNotIn('password',json.dumps(result))
        student = self.client('student24','student'); self.assertEqual(student.request('/api/audit')[0],403)


if __name__ == '__main__':
    unittest.main()
