import { getStatus } from '@calendar/api-client';
import { Alert, Button, Container, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
export function App() {
  const [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false);
  async function checkServer() {
    setLoading(true);
    try {
      const { data } = await getStatus({ baseUrl: '/api', throwOnError: true });
      setStatus(data.status === 'ok' ? 'Сервер доступен' : 'Неизвестный ответ сервера');
    } catch {
      setStatus('Не удалось связаться с сервером');
    } finally {
      setLoading(false);
    }
  }
  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title>Календарь звонков</Title>
        <Text c="dimmed">Каркас приложения готов к разработке.</Text>
        <Button loading={loading} onClick={() => void checkServer()}>
          Проверить соединение с сервером
        </Button>
        {status && <Alert title="Состояние API">{status}</Alert>}
      </Stack>
    </Container>
  );
}
