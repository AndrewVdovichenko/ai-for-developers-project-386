import { Alert, AppShell, Button, Container, Stack, Title } from '@mantine/core';
import { Link } from 'react-router';
import { ShellHeader } from '../ShellHeader';

export function BookingPage() {
  return (
    <AppShell header={{ height: 60 }} padding={0}>
      <ShellHeader />
      <AppShell.Main>
        <Container size="sm" py="xl">
          <Stack gap="md">
            <Title order={1}>Страница записи</Title>
            <Alert color="teal" title="Здесь появится календарь">
              Выбор дня, свободные слоты и&nbsp;подтверждение записи приходят на&nbsp;следующем
              этапе&nbsp;— вместе с&nbsp;бронированием в&nbsp;API.
            </Alert>
            <Button component={Link} to="/" variant="subtle" w="fit-content">
              На&nbsp;главную
            </Button>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
